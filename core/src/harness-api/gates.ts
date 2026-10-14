/**
 * The gates a harness calls (R4.5): the Model Gate and the Tool Gate, on the gateway's port. A
 * harness never holds a model or tool credential: it presents the run token of the run it holds
 * (`RunGrant.token`) as `Authorization: Bearer`, and the gate takes the session, turn and agent
 * from the token. Every call is keyed by its effect id, sent as `Idempotency-Key`: a re-send
 * with the same key and body joins the call or gets its outcome, so a harness that lost an
 * answer sends the call again instead of guessing.
 *
 * Model Gate. `POST /nylorun/v1/model-calls` with a `ModelCallBody`: `200 {outcome}` once the
 * call has finished, a model candidate or a failure outcome. `POST
 * /nylorun/v1/model-calls/{key}/cancel` aborts a keyed call (`204`).
 *
 * Tool Gate. Remote MCP servers by name (`mcp/connect`, `mcp/list`, `tool-calls`, `mcp/close`)
 * and HTTP tools by tool (`http-calls`); `tool-calls/{key}/cancel` aborts either. Each answers
 * `200 {ok: true, result}` or `200 {ok: false, error}`: a tool's failure is an answer, not a
 * gate error.
 *
 * A gate error is `{error: {code, message}}` with one of `GATE_ERROR_CODES`: `401
 * gate_unauthorized` (missing, malformed, expired or foreign token), `403 gate_forbidden`
 * (another session's call), `409 run_stale` (the token's lease is no longer the session's),
 * `400 invalid_request`, `409 gate_conflict` (another request runs under the same key). A run's
 * tool call must be journaled first (`effect.intent` answered `execute`) and keyed by its effect
 * id: else `400 key_required` or `409 effect_not_journaled`.
 */
import { z } from "zod";
import type { ModelCall, ModelCandidate, ModelFailureOutcome } from "../types/model.js";

export const MODEL_CALLS_PATH = "/nylorun/v1/model-calls";
export const MCP_CONNECT_PATH = "/nylorun/v1/mcp/connect";
export const MCP_LIST_PATH = "/nylorun/v1/mcp/list";
export const MCP_CLOSE_PATH = "/nylorun/v1/mcp/close";
export const TOOL_CALLS_PATH = "/nylorun/v1/tool-calls";
export const HTTP_CALLS_PATH = "/nylorun/v1/http-calls";

/** Largest model call body the gate reads: one `ModelCall` with its whole projected history. */
export const MAX_MODEL_CALL_BYTES = 32 * 1024 * 1024;

/** Largest tool call body the gate reads. */
export const MAX_TOOL_BODY_BYTES = 8 * 1024 * 1024;

/**
 * One model call. It names no session, turn or agent: the gate takes them from the run token,
 * and refuses a body that names them. `call` is the engine's `ModelCall`.
 */
export const ModelCallBodySchema = z.strictObject({
  effectId: z.string().min(1),
  invocationId: z.string().min(1),
  call: z.looseObject({
    prompt: z.array(z.unknown()),
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
});

export type ModelCallBody = Omit<z.infer<typeof ModelCallBodySchema>, "call"> & { readonly call: ModelCall };

/** What a model call answers: a candidate, or a failure the engine fails its step with. */
export interface ModelCallResponse {
  readonly outcome: ModelCandidate | ModelFailureOutcome;
}

export const GATE_ERROR_CODES = [
  "gate_unauthorized",
  "gate_forbidden",
  "run_stale",
  "invalid_request",
  "gate_conflict",
  /** A run's tool call without its effect id as `Idempotency-Key`. */
  "key_required",
  /** A run's tool call the effect journal does not hold, running, as sent: journal it first. */
  "effect_not_journaled",
] as const;
export type GateErrorCode = (typeof GATE_ERROR_CODES)[number];

/** An error answer: `{error: {code, message}}`. */
export const GateErrorBodySchema = z.strictObject({
  error: z.strictObject({ code: z.enum(GATE_ERROR_CODES), message: z.string() }),
});
export type GateErrorBody = z.infer<typeof GateErrorBodySchema>;

/** A remote MCP server of the session's pinned manifest, by name. */
export const McpServerRefSchema = z.object({
  /** Required with core's credential; a run token names the session itself. */
  sessionId: z.string().min(1).optional(),
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  agentId: z.string().min(1).optional(),
  serverName: z.string().min(1),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

/** `mcp/connect` and `mcp/close`. */
export const McpServerBodySchema = z.object({ server: McpServerRefSchema });

/** `mcp/list`: one page of `tools/list`. */
export const McpListBodySchema = z.object({
  server: McpServerRefSchema,
  cursor: z.string().optional(),
});

/** `tool-calls`: one `tools/call`, keyed by its effect id. */
export const ToolCallBodySchema = z.object({
  server: McpServerRefSchema,
  effectId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallBody = z.infer<typeof ToolCallBodySchema>;

/**
 * `http-calls`: one call of an HTTP tool, named by its agent and tool, or a flow's
 * HTTP stage or verifier by its stage key. The gate finds its URL, method and credential in the
 * session's pinned manifest. A run token's turn is the call's; `turnId` counts only under core's
 * credential.
 */
export const HttpCallBodySchema = z.object({
  tool: z.union([
    z.object({
      sessionId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      toolName: z.string().min(1),
    }),
    z.object({
      sessionId: z.string().min(1).optional(),
      /** A flow's HTTP stage or HTTP verifier. */
      stage: z.string().min(1),
    }),
  ]),
  effectId: z.string().min(1),
  turnId: z.string().min(1),
  input: z.unknown(),
});
export type HttpCallBody = z.infer<typeof HttpCallBodySchema>;

/** How an MCP tool call failed, coded; the failed outcome the model sees carries the code. */
export const MCP_FAILURE_CODES = [
  "mcp.unreachable",
  "credential_rejected",
  "mcp.forbidden",
  "mcp.error",
  "mcp.status",
  "mcp.lost",
  "mcp.too-large",
] as const;
export type McpFailureCode = (typeof MCP_FAILURE_CODES)[number];

/** Why an MCP request failed. Its message has no credential value in it. */
export interface McpGateError {
  readonly message: string;
  /** The MCP SDK's error code, or an HTTP status for transport errors (401 for a refused token). */
  readonly code?: number;
  /** The vault credentials a refused authorization names. */
  readonly credentialIds?: readonly string[];
  /** The call may have run: its earlier attempt was lost with the gateway. */
  readonly uncertain?: boolean;
  readonly failure?: {
    readonly code: McpFailureCode;
    readonly message: string;
    /** The request reached the server, so it may have acted on it. */
    readonly sent: boolean;
    readonly retryable: boolean;
    readonly server?: string;
    readonly redacted?: number;
  };
}

/** A Tool Gate answer. */
export type McpAnswer<T> =
  | {
      readonly ok: true;
      readonly result: T;
      /** A `tools/call`'s: how many credential values its result echoed, replaced. */
      readonly redacted?: number;
    }
  | { readonly ok: false; readonly error: McpGateError };
