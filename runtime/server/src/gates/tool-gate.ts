/**
 * The Tool Gate seam (blueprint §12, F4.1). Every tool call that leaves the loop crosses one
 * `ToolGate`: a remote MCP server's connection and calls, and an HTTP tool's request (R2 M3).
 * The gate owns what those need that the loop must not hold: the MCP and HTTP tool credentials,
 * and the outbound route.
 *
 * Two implementations: `inProcessToolGate` (embedding, the ephemeral Runtime, tests), which
 * opens remote servers and calls HTTP tools in this process, and the HTTP client of the gates
 * service (`tool-client.ts`, the `gateway` container). The sandbox tools never cross it. A
 * harness's MCP pool opens every server through a gate (`openMcp`), in process too (protocol
 * 15): the vault authorizes a connection only here.
 */
import { openMcpServer, type LiveConnection } from "../mcp/connect.js";
import { findServer, type McpServerRef } from "../mcp/pool.js";
import type { AgentManifest } from "@nylorun/core/define";
import type { OutboundPolicy } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import { runHttpTool, type HttpOutcome, type HttpToolCall, type HttpToolTenant } from "./http-tool.js";

export interface ToolGate {
  /**
   * Opens a remote (`streamable-http` or `sse`) MCP server of a session: the one its pinned
   * manifest declares, authorized with the Tenant vault. Absent: this Runtime opens no MCP
   * server.
   */
  openMcp?(server: McpServerRef): Promise<LiveConnection>;
  /**
   * Calls an HTTP tool of a session (R2 M3), keyed by the call's effect id. A failed request is
   * a failed outcome; it throws only when the call's fate is unknown (the gate was lost, or the
   * call was lost with it) or `signal` aborts. Absent: this Runtime cannot run HTTP tools.
   */
  callHttp?(call: HttpToolCall, signal: AbortSignal): Promise<HttpOutcome>;
  /**
   * True when a keyed MCP or HTTP tool call outlives the caller's process (the gates service,
   * G3): after a takeover or a shutdown, re-sending it joins the call or returns its outcome,
   * and a call lost with the gateway runs again under the same key (R5.3).
   */
  readonly recovers?: boolean;
  /** Stops a keyed tool call that outlives its caller (a user cancel). Never rejects. */
  cancel?(request: { tenantId: string; sessionId: string; effectId: string }): Promise<void>;
}

/**
 * The Tool Gate in the caller's process: remote MCP servers and HTTP tools with `tenant`'s
 * sessions and vault. `openMcp` finds the server in the session's pinned manifest (as the gates
 * service does), so a caller names a server, never a URL or a credential. `open` replaces how a
 * server is opened (tests).
 */
export function inProcessToolGate(
  policy: OutboundPolicy = {},
  tenant?: HttpToolTenant & { readonly logger?: Logger; readonly open?: typeof openMcpServer },
): ToolGate {
  if (!tenant) return {};
  const open = tenant.open ?? openMcpServer;
  return {
    callHttp: (call: HttpToolCall, signal: AbortSignal) =>
      runHttpTool(tenant, call, { policy, signal, ...(tenant.logger ? { logger: tenant.logger } : {}) }),
    async openMcp(server: McpServerRef) {
      const session = await tenant.session(server.sessionId);
      if (!session) throw new Error(`Session ${server.sessionId} not found`);
      const declared = findServer(session.manifest as AgentManifest, server.agentId, server.serverName);
      if (!declared) throw new Error(`MCP server '${server.serverName}' is not declared`);
      return open({
        server: declared.server,
        policy,
        authorize: (url) =>
          tenant.authorize(server.sessionId, {
            url,
            serverName: server.serverName,
            ...(server.agentId === undefined ? {} : { agentId: server.agentId }),
          }),
      });
    },
  };
}

/**
 * How a harness's MCP pool opens a server: through `gate`, or, for a Runtime whose gate opens
 * none, never (the call fails to the model as `mcp.unreachable`).
 */
export function openMcpThrough(gate: Pick<ToolGate, "openMcp">): (server: McpServerRef) => Promise<LiveConnection> {
  return (server) =>
    gate.openMcp
      ? gate.openMcp(server)
      : Promise.reject(new Error("This Runtime opens MCP servers only through a Tool Gate, and has none"));
}
