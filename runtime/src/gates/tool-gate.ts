/**
 * The Tool Gate seam (blueprint §12, F4.1). Every tool call that leaves the loop crosses one
 * `ToolGate`: a remote MCP server's connection and calls, an HTTP tool's request (R2 M3), and
 * every Action delivery to an Action endpoint. The gate owns what those need that the loop must
 * not hold: the MCP and HTTP tool credentials and their OAuth refresh, and the outbound route.
 *
 * Two implementations: `inProcessToolGate` (embedding, the ephemeral Runtime, tests), which
 * opens remote servers, calls HTTP tools and POSTs deliveries in this process, and the HTTP
 * client of the gates service (`tool-client.ts`, the `gateway` container). Stdio MCP servers
 * and the sandbox tools never cross it: they run beside the loop until the session sandbox
 * takes them (P4).
 */
import type { LiveConnection } from "../mcp/connect.js";
import type { McpServerRef } from "../mcp/pool.js";
import { post, type OutboundPolicy, type OutboundResult } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import { runHttpTool, type HttpOutcome, type HttpToolCall, type HttpToolTenant } from "./http-tool.js";

/** One Action delivery or endpoint ping, signed by the caller. */
export interface DeliveryRequest {
  readonly url: string;
  readonly body: string;
  /** `Nylorun-Signature`, `Nylorun-Protocol` and `Idempotency-Key`; nothing else. */
  readonly headers: Readonly<Record<string, string>>;
  /** How long the endpoint may take to answer. */
  readonly timeoutMs: number;
}

export interface ToolGate {
  /**
   * Opens a remote (`streamable-http` or `sse`) MCP server of a session. Absent: the loop's
   * pool opens it itself, with the Tenant vault.
   */
  openMcp?(server: McpServerRef): Promise<LiveConnection>;
  /**
   * Calls an HTTP tool of a session (R2 M3), keyed by the call's effect id. A failed request is
   * a failed outcome; it throws only when the call's fate is unknown (the gate was lost, or the
   * call was lost with it) or `signal` aborts. Absent: this Runtime cannot run HTTP tools.
   */
  callHttp?(call: HttpToolCall, signal: AbortSignal): Promise<HttpOutcome>;
  /** POSTs a delivery. Never throws; `signal` aborts it (see `tenant/outbound.ts`). */
  post(request: DeliveryRequest, signal: AbortSignal): Promise<OutboundResult>;
  /**
   * True when a keyed MCP or HTTP tool call outlives the caller's process (the gates service,
   * G3): after a takeover or a shutdown, re-sending it joins the call or returns its outcome,
   * and a call lost with the gateway answers `uncertain` instead of running again.
   */
  readonly recovers?: boolean;
  /** Stops a keyed tool call that outlives its caller (a user cancel). Never rejects. */
  cancel?(request: { tenantId: string; sessionId: string; effectId: string }): Promise<void>;
}

/**
 * The Tool Gate in the caller's process: remote MCP through the pool, deliveries by `post`, and
 * HTTP tools with `tenant`'s sessions and vault.
 */
export function inProcessToolGate(
  policy: OutboundPolicy = {},
  tenant?: HttpToolTenant & { readonly logger?: Logger },
): ToolGate {
  return {
    ...(tenant
      ? {
          callHttp: (call: HttpToolCall, signal: AbortSignal) =>
            runHttpTool(tenant, call, { policy, signal, ...(tenant.logger ? { logger: tenant.logger } : {}) }),
        }
      : {}),
    post: (request, signal) =>
      post(request.url, request.body, { ...request.headers }, {
        policy,
        signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
      }),
  };
}
