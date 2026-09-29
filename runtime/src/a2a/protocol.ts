/**
 * A2A 1.0 over JSON-RPC: the wire types the Runtime answers with, the envelope, the error
 * codes and the parameter checks (Host feature `a2a-endpoint`). Only what v1 serves is typed:
 * text and data parts, tasks, the card. Field names are the spec's ProtoJSON (camelCase,
 * enum values such as `TASK_STATE_WORKING`). No Tenant state is read here.
 */

/** The A2A version this endpoint speaks (`A2A-Version`, Major.Minor). */
export const A2A_VERSION = "1.0";

export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export type Part =
  | { text: string; mediaType?: string; metadata?: Record<string, unknown> }
  | { data: unknown; mediaType?: string; metadata?: Record<string, unknown> };

export interface Message {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
}

/** The standard JSON-RPC codes and the A2A codes (spec §5.4, §9.5). */
export const A2A_ERRORS = {
  parse: { code: -32700, reason: "INVALID_JSON" },
  invalidRequest: { code: -32600, reason: "INVALID_REQUEST" },
  methodNotFound: { code: -32601, reason: "METHOD_NOT_FOUND" },
  invalidParams: { code: -32602, reason: "INVALID_PARAMS" },
  internal: { code: -32603, reason: "INTERNAL" },
  taskNotFound: { code: -32001, reason: "TASK_NOT_FOUND" },
  taskNotCancelable: { code: -32002, reason: "TASK_NOT_CANCELABLE" },
  pushNotSupported: { code: -32003, reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" },
  unsupportedOperation: { code: -32004, reason: "UNSUPPORTED_OPERATION" },
  contentTypeNotSupported: { code: -32005, reason: "CONTENT_TYPE_NOT_SUPPORTED" },
  versionNotSupported: { code: -32009, reason: "VERSION_NOT_SUPPORTED" },
} as const;

export type A2aErrorKind = keyof typeof A2A_ERRORS;

/** An error answered in the JSON-RPC body, with `google.rpc.ErrorInfo` (and `BadRequest`). */
export class A2aError extends Error {
  constructor(
    readonly kind: A2aErrorKind,
    message: string,
    readonly metadata: Readonly<Record<string, string>> = {},
    /** `google.rpc.BadRequest` field violations, for invalid parameters. */
    readonly field?: string
  ) {
    super(message);
    this.name = "A2aError";
  }
}

export const a2aFail = (
  kind: A2aErrorKind,
  message: string,
  metadata?: Record<string, string>,
  field?: string
): never => {
  throw new A2aError(kind, message, metadata, field);
};

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: JsonRpcId, error: A2aError): unknown {
  const { code, reason } = A2A_ERRORS[error.kind];
  const data: unknown[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "a2a-protocol.org",
      metadata: { ...error.metadata },
    },
  ];
  if (error.field !== undefined)
    data.push({
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field: error.field, description: error.message }],
    });
  return { jsonrpc: "2.0", id, error: { code, message: error.message, data } };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON-RPC 2.0 request object, or an `A2aError` (`id` recovered when possible). */
export function parseEnvelope(
  text: string
): { ok: true; request: JsonRpcRequest } | { ok: false; id: JsonRpcId; error: A2aError } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, id: null, error: new A2aError("parse", "Invalid JSON payload") };
  }
  const invalid = (id: JsonRpcId, message: string) => ({
    ok: false as const,
    id,
    error: new A2aError("invalidRequest", message),
  });
  if (!isObject(body)) return invalid(null, "The body must be one JSON-RPC request object");
  const id = body.id;
  const validId =
    typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) || id === null;
  const safeId: JsonRpcId = validId ? (id as JsonRpcId) : null;
  if (body.jsonrpc !== "2.0") return invalid(safeId, 'jsonrpc must be "2.0"');
  // A2A has no notifications: every request is answered, so it needs an id.
  if (!("id" in body) || !validId) return invalid(null, "The request needs an id");
  if (typeof body.method !== "string" || body.method === "")
    return invalid(safeId, "The request needs a method");
  if (body.params !== undefined && !isObject(body.params))
    return invalid(safeId, "params must be an object");
  return {
    ok: true,
    request: {
      id: safeId,
      method: body.method,
      params: (body.params as Record<string, unknown> | undefined) ?? {},
    },
  };
}

/** `A2A-Version` as Major.Minor; empty means 0.3 (spec §3.6.2). */
export function checkVersion(value: string | null | undefined): void {
  const trimmed = (value ?? "").trim();
  const [major, minor] = trimmed === "" ? ["0", "3"] : trimmed.split(".");
  if (`${major}.${minor}` !== A2A_VERSION)
    a2aFail(
      "versionNotSupported",
      `A2A version ${trimmed === "" ? "0.3" : trimmed} is not supported; send A2A-Version: ${A2A_VERSION}`,
      { supportedVersions: A2A_VERSION }
    );
}

const MAX_ID = 200;
const VISIBLE = /^[\x21-\x7e]+$/;

function checkId(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0)
    return a2aFail("invalidParams", `${field} must be a non-empty string`, {}, field);
  if (value.length > MAX_ID || !VISIBLE.test(value))
    return a2aFail(
      "invalidParams",
      `${field} must be 1 to ${MAX_ID} visible ASCII characters`,
      {},
      field
    );
  return value;
}

/** A client's message reduced to what the Runtime runs: text, or one JSON value. */
export type MessageInput = { content: string } | { data: unknown };

export interface SendParams {
  messageId: string;
  contextId?: string;
  taskId?: string;
  input: MessageInput;
  returnImmediately: boolean;
  historyLength?: number;
}

export function parseHistoryLength(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return a2aFail("invalidParams", `${field} must be a non-negative integer`, {}, field);
  return value;
}

/** The input of one part: exactly one of `text`, `raw`, `url`, `data` (spec §4.1.6). */
function partKind(part: unknown, field: string): "text" | "data" | "file" {
  if (!isObject(part)) return a2aFail("invalidParams", `${field} must be an object`, {}, field);
  const kinds = (["text", "raw", "url", "data"] as const).filter((k) => part[k] !== undefined);
  if (kinds.length !== 1)
    return a2aFail(
      "invalidParams",
      `${field} must contain exactly one of text, raw, url, data`,
      {},
      field
    );
  if (kinds[0] === "text" && typeof part.text !== "string")
    return a2aFail("invalidParams", `${field}.text must be a string`, {}, `${field}.text`);
  return kinds[0] === "raw" || kinds[0] === "url" ? "file" : kinds[0];
}

/** `SendMessage` params (spec §3.2.1), checked in the order a client can fix them. */
export function parseSendParams(params: Record<string, unknown>): SendParams {
  const message = params.message;
  if (!isObject(message))
    return a2aFail("invalidParams", "message is required", {}, "message");
  const messageId = checkId(message.messageId, "message.messageId", true)!;
  if (message.role !== "ROLE_USER")
    a2aFail("invalidParams", 'message.role must be "ROLE_USER"', {}, "message.role");
  const contextId = checkId(message.contextId, "message.contextId", false);
  const taskId = checkId(message.taskId, "message.taskId", false);
  if (!Array.isArray(message.parts) || message.parts.length === 0)
    a2aFail("invalidParams", "At least one part is required", {}, "message.parts");
  const parts = message.parts as Record<string, unknown>[];
  const kinds = parts.map((part, index) => partKind(part, `message.parts[${index}]`));
  const configuration = params.configuration;
  if (configuration !== undefined && !isObject(configuration))
    a2aFail("invalidParams", "configuration must be an object", {}, "configuration");
  const config = (configuration ?? {}) as Record<string, unknown>;
  if (config.taskPushNotificationConfig !== undefined && config.taskPushNotificationConfig !== null)
    a2aFail("pushNotSupported", "Push notifications are not supported");
  if (config.returnImmediately !== undefined && typeof config.returnImmediately !== "boolean")
    a2aFail(
      "invalidParams",
      "configuration.returnImmediately must be a boolean",
      {},
      "configuration.returnImmediately"
    );
  const historyLength = parseHistoryLength(config.historyLength, "configuration.historyLength");
  let input: MessageInput;
  if (kinds.every((kind) => kind === "text"))
    input = { content: parts.map((part) => part.text as string).join("\n") };
  else if (kinds.length === 1 && kinds[0] === "data") input = { data: parts[0]!.data };
  else
    return a2aFail(
      "contentTypeNotSupported",
      "This agent accepts text parts, or a single data part; files are not supported",
      { accepted: "text/plain,application/json" }
    );
  if ("content" in input && input.content.trim() === "")
    a2aFail("invalidParams", "The message has no text", {}, "message.parts");
  return {
    messageId,
    ...(contextId !== undefined ? { contextId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    input,
    returnImmediately: config.returnImmediately === true,
    ...(historyLength !== undefined ? { historyLength } : {}),
  };
}

/** `GetTask` and `CancelTask` params: the task id (and `historyLength` for `GetTask`). */
export function parseTaskParams(params: Record<string, unknown>): {
  id: string;
  historyLength?: number;
} {
  if (typeof params.id !== "string" || params.id === "")
    return a2aFail("invalidParams", "id is required", {}, "id");
  const historyLength = parseHistoryLength(params.historyLength, "historyLength");
  return { id: params.id, ...(historyLength !== undefined ? { historyLength } : {}) };
}
