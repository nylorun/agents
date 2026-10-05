/**
 * The Tool Gate's wire format (blueprint §12, F4.1): the routes the loop calls on the gates
 * service for remote MCP servers, HTTP tools and Action deliveries. Internal, like the model call route
 * (`contract.ts`): same optional Tenant header, not in the published OpenAPI documents.
 *
 * Credentials (F5). A session's MCP requests carry its run token, and the gate takes the
 * session from it: `server.sessionId` is then absent (or the token's). Core's credential
 * (`NYLORUN_GATES_TOKEN`) is accepted too, for requests made outside a run, and then
 * `server.sessionId` names the session. Deliveries accept core's credential only.
 *
 * Remote MCP. The gate holds the connection and the vault credential; the loop names the
 * server, never a URL or a credential, and the gate finds it in the session's pinned manifest.
 * - `POST /nylorun/v1/mcp/connect` `{server}`: opens the server's connection (vault
 *   authorization included), or keeps the open one.
 * - `POST /nylorun/v1/mcp/list` `{server, cursor?}`: one page of `tools/list`.
 * - `POST /nylorun/v1/tool-calls` `{server, effectId, name, arguments}`: one
 *   `tools/call`. With an `Idempotency-Key` (the effect id) the call outlives its client and runs
 *   once (G3); a re-send joins it or gets its outcome.
 * - `POST /nylorun/v1/tool-calls/{key}/cancel`: aborts a keyed call; `204` either way, `403
 *   gate_forbidden` for another session's call under a run token.
 * - `POST /nylorun/v1/mcp/close` `{server}`: closes the server's connection; `204`.
 * Each answers `200 {ok: true, result}` or `200 {ok: false, error}`: an MCP failure is an
 * answer, not a gate error. A keyed call whose earlier attempt was lost with the gateway answers
 * `{ok: false, error: {uncertain: true}}` and is never run again.
 *
 * HTTP tools (R2 M3). `POST /nylorun/v1/http-calls` `{tool, effectId, turnId, input}`: one call
 * of an HTTP tool. The loop names the tool (`{sessionId?, agentId?, capabilityId, toolName}`);
 * the gate finds its URL, method and credential in the session's pinned manifest
 * (`gates/http-tool.ts`). A run token's turn is the call's; `turnId` counts only under core's
 * credential. Keyed like a tool call, and cancelled by the same route. It answers
 * `200 {ok: true, result}` with the tool outcome (a failed request is a failed outcome the
 * model sees), or `{ok: false, error: {uncertain: true}}` for a call lost with the gateway.
 *
 * Action deliveries. `POST /nylorun/v1/deliveries` `{url, body, headers, timeoutMs}`: the gate
 * POSTs the signed delivery under the gateway's own address policy and answers `200 {result}`,
 * what `tenant/outbound.ts` `post` returned, with the answer's body in base64.
 */
import { z } from "zod";
import { PROTOCOL_HEADER, SIGNATURE_HEADER } from "@nylorun/core/compatibility";

export const MCP_CONNECT_PATH = "/nylorun/v1/mcp/connect";
export const MCP_LIST_PATH = "/nylorun/v1/mcp/list";
export const MCP_CLOSE_PATH = "/nylorun/v1/mcp/close";
export const TOOL_CALLS_PATH = "/nylorun/v1/tool-calls";
export const DELIVERIES_PATH = "/nylorun/v1/deliveries";
export const HTTP_CALLS_PATH = "/nylorun/v1/http-calls";

/** Largest tool call or delivery body the gate reads. */
export const MAX_TOOL_BODY_BYTES = 8 * 1024 * 1024;

/** The longest delivery timeout the gate accepts: an endpoint's maximum `timeoutMs`. */
export const MAX_DELIVERY_TIMEOUT_MS = 15 * 60_000;

/** The only headers the gate forwards on a delivery, lower-cased. */
export const DELIVERY_HEADERS: ReadonlySet<string> = new Set([
  SIGNATURE_HEADER.toLowerCase(),
  PROTOCOL_HEADER.toLowerCase(),
  "idempotency-key",
]);

export const McpServerRefSchema = z.object({
  /** Required with core's credential; a run token names the session itself. */
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  capabilityId: z.string().min(1),
  serverName: z.string().min(1),
});

export const McpServerBodySchema = z.object({ server: McpServerRefSchema });

export const McpListBodySchema = z.object({
  server: McpServerRefSchema,
  cursor: z.string().optional(),
});

export const ToolCallBodySchema = z.object({
  server: McpServerRefSchema,
  effectId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export type ToolCallBody = z.infer<typeof ToolCallBodySchema>;

export const HttpCallBodySchema = z.object({
  tool: z.object({
    /** Required with core's credential; a run token names the session itself. */
    sessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    capabilityId: z.string().min(1),
    toolName: z.string().min(1),
  }),
  effectId: z.string().min(1),
  turnId: z.string().min(1),
  input: z.unknown(),
});

export type HttpCallBody = z.infer<typeof HttpCallBodySchema>;

/** Why an MCP request failed, as the loop's diagnostics read it (`mcp/connect.ts`). */
export interface McpGateError {
  readonly message: string;
  /** The MCP SDK's error code, an HTTP status for transport errors (401 for a refused token). */
  readonly code?: number;
  /** The vault credentials a refused authorization names. */
  readonly credentialIds?: readonly string[];
  /** The call may have run: its earlier attempt was lost with the gateway. Never re-run. */
  readonly uncertain?: boolean;
}

export type McpAnswer<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: McpGateError };

export const DeliveryBodySchema = z.object({
  url: z.string().url(),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().max(MAX_DELIVERY_TIMEOUT_MS),
});

export type DeliveryBody = z.infer<typeof DeliveryBodySchema>;

/** `OutboundResult` on the wire: the answer's body in base64. */
export type WireOutboundResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: Record<string, string | string[] | undefined>;
      readonly body: string;
    }
  | { readonly kind: "too_large"; readonly status: number }
  | { readonly kind: "not_sent"; readonly code: string; readonly message: string }
  | { readonly kind: "lost"; readonly code: string; readonly message: string };

export interface DeliveryAnswer {
  readonly result: WireOutboundResult;
}
