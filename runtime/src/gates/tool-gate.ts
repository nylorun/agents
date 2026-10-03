/**
 * The Tool Gate seam (blueprint §12, F4.1). Every tool call that leaves the loop crosses one
 * `ToolGate`: a remote MCP server's connection and calls, and every Action delivery to an
 * Action endpoint. The gate owns what those need that the loop must not hold: the MCP
 * credential and its OAuth refresh, and the outbound route.
 *
 * Two implementations: `inProcessToolGate` (embedding, the ephemeral Runtime, tests), which
 * opens remote servers and POSTs deliveries in this process, and the HTTP client of the gates
 * service (`tool-client.ts`, the `gateway` container). Stdio MCP servers and the sandbox tools
 * never cross it: they run beside the loop until the session sandbox takes them (P4).
 */
import type { LiveConnection } from "../mcp/connect.js";
import type { McpServerRef } from "../mcp/pool.js";
import { post, type OutboundPolicy, type OutboundResult } from "../tenant/outbound.js";

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
  /** POSTs a delivery. Never throws; `signal` aborts it (see `tenant/outbound.ts`). */
  post(request: DeliveryRequest, signal: AbortSignal): Promise<OutboundResult>;
  /**
   * True when a keyed MCP call outlives the caller's process (the gates service, G3): after a
   * takeover or a shutdown, re-sending it joins the call or returns its outcome, and a call
   * lost with the gateway answers `uncertain` instead of running again.
   */
  readonly recovers?: boolean;
  /** Stops a keyed MCP call that outlives its caller (a user cancel). Never rejects. */
  cancel?(request: { tenantId: string; sessionId: string; effectId: string }): Promise<void>;
}

/** The Tool Gate in the caller's process: remote MCP through the pool, deliveries by `post`. */
export function inProcessToolGate(policy: OutboundPolicy = {}): ToolGate {
  return {
    post: (request, signal) =>
      post(request.url, request.body, { ...request.headers }, {
        policy,
        signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
      }),
  };
}
