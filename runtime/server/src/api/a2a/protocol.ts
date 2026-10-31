/**
 * A2A 1.0 over JSON-RPC: the wire types the Runtime answers with, the envelope, the error
 * codes and the parameter checks (Host features `a2a-endpoint` and `a2a-profile-v2`). Only what
 * the Runtime serves is typed: text, data, `raw` and `url` parts, tasks, their status and
 * artifact updates (push), push configs, the card. Field names are the spec's ProtoJSON
 * (camelCase, enum values such as `TASK_STATE_WORKING`). No Tenant state is read here.
 */
import { A2A_EXTENSIONS } from "./extensions.js";

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
  | { data: unknown; mediaType?: string; metadata?: Record<string, unknown> }
  | { raw: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> }
  | { url: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> };

export interface Message {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  /** The extensions whose data the message carries (A2A §4.6). */
  extensions?: string[];
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
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
  /** Profile v2 data about the whole task: `progress/v1`, `telemetry/v1`, `effects/v1`. */
  metadata?: Record<string, unknown>;
}

/** A change of a task's status, as a push delivers it (`StreamResponse.statusUpdate`). */
export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
}

/** An artifact of a task, as a push delivers it (`StreamResponse.artifactUpdate`). */
export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** One push's body: A2A's `StreamResponse`, one of its cases. */
export type StreamResponse =
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent }
  | { task: Task };

/** How a push authenticates to its receiver (A2A `AuthenticationInfo`): `Authorization: <scheme> <credentials>`. */
export interface PushAuthentication {
  scheme: string;
  credentials: string;
}

/** A push notification config as a client gives it (A2A `TaskPushNotificationConfig`). */
export interface PushConfigInput {
  /** The config's id within its task; the Runtime makes one when absent. */
  id?: string;
  url: string;
  /** Sent back as `X-A2A-Notification-Token` with every push. */
  token?: string;
  authentication?: PushAuthentication;
}

/** A push notification config as the Runtime answers it. */
export interface TaskPushNotificationConfig {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: PushAuthentication;
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
    readonly field?: string,
    /** `ErrorInfo.reason` when it is more precise than the kind's, as `CONTEXT_BUSY`. */
    readonly reason?: string
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
      reason: error.reason ?? reason,
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
      params: protoJsonKeys((body.params as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>,
    },
  };
}

/**
 * Params with ProtoJSON's original field names (`task_id`, `return_immediately`) read as their
 * lowerCamel JSON names, as ProtoJSON parsers must accept both. A part's `data` and any
 * `metadata` are the caller's own values and keep their keys.
 */
function protoJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protoJsonKeys);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = key.includes("_") ? key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) : key;
    // The lowerCamel name wins when a client sends both.
    if (name !== key && Object.hasOwn(value, name)) continue;
    out[name] = name === "data" || name === "metadata" ? child : protoJsonKeys(child);
  }
  return out;
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

/**
 * At most 200 characters: an identifier's grammar is the protocol's (B15), the same in every
 * installation, so its length is a constant, not a setting.
 */
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

/** A file sent inline (`raw`, base64): stored as an artifact of the context's session. */
export interface RawFile {
  readonly raw: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

/** A file sent by URL: fetched by the Runtime (`guardedFetch`), then stored as a `raw` one is. */
export interface UrlFile {
  readonly url: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

/**
 * A client's message reduced to what the Runtime runs: text, one JSON value, or text and files
 * sent inline or by URL.
 */
export type MessageInput =
  | { content: string }
  | { data: unknown }
  | { files: readonly ({ text: string } | RawFile | UrlFile)[] };

/** What a message to a busy context does (profile v2 §1): queued, or refused with `CONTEXT_BUSY`. */
export type Delivery = "queue" | "reject";

/** A caller's answer to an open interaction (`interactions/v1` on the reply message). */
export type InteractionAnswer =
  | { interactionId: string; approved: boolean }
  | { interactionId: string; value: unknown };

export interface SendParams {
  messageId: string;
  contextId?: string;
  taskId?: string;
  input: MessageInput;
  returnImmediately: boolean;
  historyLength?: number;
  /** `configuration.taskPushNotificationConfig`: where this task's updates go. */
  push?: PushConfigInput;
  /** `metadata.delivery`; default `queue`. */
  delivery: Delivery;
  /** The answer the message carries under `interactions/v1`. */
  answer?: InteractionAnswer;
}

export function parseHistoryLength(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return a2aFail("invalidParams", `${field} must be a non-negative integer`, {}, field);
  return value;
}

/** The input of one part: exactly one of `text`, `raw`, `url`, `data` (spec §4.1.6). */
function partKind(part: unknown, field: string): "text" | "data" | "raw" | "url" {
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
  if (kinds[0] === "raw" && typeof part.raw !== "string")
    return a2aFail("invalidParams", `${field}.raw must be base64 bytes`, {}, `${field}.raw`);
  if (kinds[0] === "url" && !isHttpUrl(part.url))
    return a2aFail("invalidParams", `${field}.url must be an http or https URL`, {}, `${field}.url`);
  for (const key of ["mediaType", "filename"] as const)
    if (part[key] !== undefined && typeof part[key] !== "string")
      return a2aFail("invalidParams", `${field}.${key} must be a string`, {}, `${field}.${key}`);
  return kinds[0];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The longest push token and credentials kept: a header value, not a document. */
const MAX_SECRET = 1024;

/**
 * A push notification config (A2A `TaskPushNotificationConfig`) at `field`: an http(s) `url`, an
 * optional `id`, `token` and `authentication` (`scheme`, `credentials`). Its `taskId`, when
 * present, is the caller's to check.
 */
export function parsePushConfig(value: unknown, field: string): PushConfigInput {
  if (!isObject(value)) return a2aFail("invalidParams", `${field} must be an object`, {}, field);
  if (!isHttpUrl(value.url))
    a2aFail("invalidParams", `${field}.url must be an http or https URL`, {}, `${field}.url`);
  const id = value.id === undefined || value.id === "" ? undefined : checkId(value.id, `${field}.id`, true);
  if (value.token !== undefined && (typeof value.token !== "string" || value.token.length > MAX_SECRET))
    a2aFail("invalidParams", `${field}.token must be a string of at most ${MAX_SECRET} characters`, {}, `${field}.token`);
  let authentication: PushAuthentication | undefined;
  if (value.authentication !== undefined && value.authentication !== null) {
    const auth = value.authentication;
    if (
      !isObject(auth) ||
      typeof auth.scheme !== "string" ||
      !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(auth.scheme) ||
      typeof auth.credentials !== "string" ||
      auth.credentials.length > MAX_SECRET ||
      /[\r\n]/.test(auth.credentials)
    )
      a2aFail(
        "invalidParams",
        `${field}.authentication needs an HTTP scheme and credentials`,
        {},
        `${field}.authentication`
      );
    authentication = {
      scheme: (auth as { scheme: string }).scheme,
      credentials: (auth as { credentials: string }).credentials,
    };
  }
  return {
    url: value.url as string,
    ...(id !== undefined ? { id } : {}),
    ...(typeof value.token === "string" && value.token !== "" ? { token: value.token } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

/** `metadata.delivery`: `queue` (the default) or `reject`. */
function parseDelivery(metadata: Record<string, unknown>): Delivery {
  const delivery = metadata.delivery;
  if (delivery === undefined || delivery === null) return "queue";
  if (delivery !== "queue" && delivery !== "reject")
    return a2aFail("invalidParams", 'message.metadata.delivery must be "queue" or "reject"', {}, "message.metadata.delivery");
  return delivery;
}

/** The answer under `interactions/v1`, when the message carries one. */
function parseAnswer(metadata: Record<string, unknown>): InteractionAnswer | undefined {
  const field = `message.metadata["${A2A_EXTENSIONS.interactions}"]`;
  const raw = metadata[A2A_EXTENSIONS.interactions];
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) return a2aFail("invalidParams", `${field} must be an object`, {}, field);
  const interactionId = checkId(raw.interactionId, `${field}.interactionId`, true)!;
  if (raw.approved !== undefined) {
    if (typeof raw.approved !== "boolean")
      a2aFail("invalidParams", `${field}.approved must be a boolean`, {}, `${field}.approved`);
    if (raw.value !== undefined)
      a2aFail("invalidParams", `${field} takes approved or value, not both`, {}, field);
    return { interactionId, approved: raw.approved as boolean };
  }
  if (!("value" in raw))
    return a2aFail("invalidParams", `${field} needs approved or value`, {}, field);
  return { interactionId, value: raw.value };
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
  if (message.metadata !== undefined && message.metadata !== null && !isObject(message.metadata))
    a2aFail("invalidParams", "message.metadata must be an object", {}, "message.metadata");
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  // On the message (the profile's place), or on the request's own metadata.
  const delivery = parseDelivery(
    metadata.delivery === undefined && isObject(params.metadata) ? params.metadata : metadata
  );
  const answer = parseAnswer(metadata);
  const configuration = params.configuration;
  if (configuration !== undefined && configuration !== null && !isObject(configuration))
    a2aFail("invalidParams", "configuration must be an object", {}, "configuration");
  const config = (configuration ?? {}) as Record<string, unknown>;
  const push =
    config.taskPushNotificationConfig === undefined || config.taskPushNotificationConfig === null
      ? undefined
      : parsePushConfig(config.taskPushNotificationConfig, "configuration.taskPushNotificationConfig");
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
  else if (kinds.includes("data"))
    return a2aFail(
      "contentTypeNotSupported",
      "This agent accepts text and file parts, or a single data part",
      { accepted: "text/plain,application/json" }
    );
  else
    input = {
      files: parts.map((part, index) => {
        const named = {
          ...(part.mediaType !== undefined ? { mediaType: part.mediaType as string } : {}),
          ...(part.filename !== undefined ? { filename: part.filename as string } : {}),
        };
        return kinds[index] === "text"
          ? { text: part.text as string }
          : kinds[index] === "url"
          ? { url: part.url as string, ...named }
          : { raw: part.raw as string, ...named };
      }),
    };
  // An answer may carry its value only in metadata: its parts are then what a person reads.
  if ("content" in input && input.content.trim() === "" && answer === undefined)
    a2aFail("invalidParams", "The message has no text", {}, "message.parts");
  return {
    messageId,
    ...(contextId !== undefined ? { contextId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    input,
    returnImmediately: config.returnImmediately === true,
    ...(historyLength !== undefined ? { historyLength } : {}),
    ...(push ? { push } : {}),
    delivery,
    ...(answer ? { answer } : {}),
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

/** `taskId` of a push config method's params. */
function pushTaskId(params: Record<string, unknown>): string {
  if (typeof params.taskId !== "string" || params.taskId === "")
    return a2aFail("invalidParams", "taskId is required", {}, "taskId");
  return params.taskId;
}

/** `CreateTaskPushNotificationConfig` params: a `TaskPushNotificationConfig` naming its task. */
export function parseCreatePushParams(params: Record<string, unknown>): {
  taskId: string;
  config: PushConfigInput;
} {
  const taskId = pushTaskId(params);
  // A2A 1.0 sends the config itself; an earlier draft nested it under `config`.
  const config = isObject(params.config) ? { ...params.config, ...(params.id ? { id: params.id } : {}) } : params;
  return { taskId, config: parsePushConfig(config, isObject(params.config) ? "config" : "params") };
}

/** `GetTaskPushNotificationConfig` and `DeleteTaskPushNotificationConfig` params. */
export function parsePushConfigRef(params: Record<string, unknown>): { taskId: string; id: string } {
  const taskId = pushTaskId(params);
  const id = checkId(params.id, "id", true)!;
  return { taskId, id };
}

/** The most configs one page of `ListTaskPushNotificationConfigs` holds. */
export const PUSH_CONFIG_PAGE = 100;

/** `ListTaskPushNotificationConfigs` params: the task, and paging. */
export function parseListPushParams(params: Record<string, unknown>): {
  taskId: string;
  pageSize: number;
  pageToken?: string;
} {
  const taskId = pushTaskId(params);
  const size = params.pageSize;
  if (size !== undefined && size !== null && size !== 0 && (typeof size !== "number" || !Number.isInteger(size) || size < 1))
    a2aFail("invalidParams", "pageSize must be a positive integer", {}, "pageSize");
  const pageSize = Math.min(typeof size === "number" && size > 0 ? size : PUSH_CONFIG_PAGE, PUSH_CONFIG_PAGE);
  const token = params.pageToken;
  if (token !== undefined && token !== null && token !== "" && typeof token !== "string")
    a2aFail("invalidParams", "pageToken must be a string", {}, "pageToken");
  return { taskId, pageSize, ...(typeof token === "string" && token !== "" ? { pageToken: token } : {}) };
}
