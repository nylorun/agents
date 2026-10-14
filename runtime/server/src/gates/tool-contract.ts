/**
 * The Tool Gate's wire format (blueprint §12, F4.1): the routes the loop calls on the gates
 * service for remote MCP servers and HTTP tools. Like the model call route (`contract.ts`): same
 * optional Tenant header, bodies published in `@nylorun/core/harness-api` (R4.5).
 *
 * Credentials (F5). A session's MCP requests carry its run token, and the gate takes the
 * session from it: `server.sessionId` is then absent (or the token's). Core's credential
 * (`NYLORUN_GATES_TOKEN`) is accepted too, for requests made outside a run, and then
 * `server.sessionId` names the session.
 *
 * Remote MCP. The gate holds the connection and the vault credential; the loop names the
 * server, never a URL or a credential, and the gate finds it in the session's pinned manifest.
 * - `POST /nylorun/v1/mcp/connect` `{server}`: opens the server's connection (vault
 *   authorization included), or keeps the open one. Its result is `{instructions}` when the
 *   server gave instructions at `initialize` (R2b C10, for the note on its deferred tools), else
 *   `null`.
 * - `POST /nylorun/v1/mcp/list` `{server, cursor?}`: one page of `tools/list`.
 * - `POST /nylorun/v1/tool-calls` `{server, effectId, name, arguments}`: one
 *   `tools/call`. With an `Idempotency-Key` (the effect id) the call outlives its client and runs
 *   once (G3); a re-send joins it or gets its outcome.
 * - `POST /nylorun/v1/tool-calls/{key}/cancel`: aborts a keyed call; `204` either way, `403
 *   gate_forbidden` for another session's call under a run token.
 * - `POST /nylorun/v1/mcp/close` `{server}`: closes the server's connection; `204`.
 * Each answers `200 {ok: true, result}` or `200 {ok: false, error}`: an MCP failure is an
 * answer, not a gate error. A tool call's failure is coded (`error.failure`, R2b C7), and neither
 * a result nor a failure carries a credential value the gate sent (C8). An answer past 8 MiB is
 * `mcp.too-large` (C11), as an HTTP tool's is `http.too-large`; core shapes what fits into a
 * result the model can take (`tenant/tool-results.ts`). A keyed call whose earlier attempt was
 * lost with the gateway runs again under the same key (R5.3); one another gateway process holds
 * answers `{ok: false, error: {uncertain: true}}`, and the caller sends it again.
 *
 * HTTP tools (R2 M3). `POST /nylorun/v1/http-calls` `{tool, effectId, turnId, input}`: one call
 * of an HTTP tool. The loop names the tool (`{sessionId?, agentId?, toolName}`), or a
 * flow's HTTP stage or HTTP verifier by its stage key (`{sessionId?, stage}`); the gate finds its
 * URL, method and credential in the session's pinned manifest
 * (`gates/http-tool.ts`). A run token's turn is the call's; `turnId` counts only under core's
 * credential. Keyed like a tool call, and cancelled by the same route. It answers
 * `200 {ok: true, result}` with the tool outcome (a failed request is a failed outcome the
 * model sees), or `{ok: false, error: {uncertain: true}}` for a call another gateway process holds.
 */
import type { McpCallFailure } from "../mcp/connect.js";

export {
  HTTP_CALLS_PATH,
  HttpCallBodySchema,
  MAX_TOOL_BODY_BYTES,
  MCP_CLOSE_PATH,
  MCP_CONNECT_PATH,
  MCP_LIST_PATH,
  McpListBodySchema,
  McpServerBodySchema,
  McpServerRefSchema,
  TOOL_CALLS_PATH,
  ToolCallBodySchema,
  type HttpCallBody,
  type ToolCallBody,
} from "@nylorun/core/harness-api";

/** Why an MCP request failed, as the loop's diagnostics read it (`mcp/connect.ts`). */
export interface McpGateError {
  readonly message: string;
  /** The MCP SDK's error code, an HTTP status for transport errors (401 for a refused token). */
  readonly code?: number;
  /** The vault credentials a refused authorization names. */
  readonly credentialIds?: readonly string[];
  /** Not answered here: another gateway process holds the keyed call. Send it again (R5.3). */
  readonly uncertain?: boolean;
  /**
   * How the request failed, coded (R2b C1, C7): the loop's `McpCallFailed`, which a tool call
   * turns into a failed outcome the model sees (`mcp.lost` included). `credential_rejected` for a
   * `401`, with the server. Its message has no credential value in it (C8).
   */
  readonly failure?: McpCallFailure;
}

export type McpAnswer<T> =
  | {
      readonly ok: true;
      readonly result: T;
      /** A `tools/call`'s: how many credential values its result echoed, replaced (R2b C8). */
      readonly redacted?: number;
    }
  | { readonly ok: false; readonly error: McpGateError };
