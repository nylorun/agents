/**
 * An A2A 1.0 client for one agent's JSON-RPC endpoint (a Nylorun Runtime's
 * `/v1/a2a/agents/{agentId}`, the SDK gateway, or any A2A agent), with the Nylorun profile v2's
 * extensions activated, and the Runtime's change feed (`GET /v1/turns`). Plain `fetch`: it loads
 * no A2A package and needs no Runtime client.
 */
import { SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import { parseSubjectHeaders, type SubjectScope } from "@nylorun/core/contracts";
import { readBody, requestHeaders } from "@nylorun/core/transport";
import { RuntimeError } from "../http.js";
import { A2A_EXTENSIONS, A2A_PROFILE_EXTENSIONS } from "./profile.js";
import type {
  AgentCard,
  ListTasksResult,
  Message,
  Metadata,
  Part,
  PushNotificationConfig,
  Task,
  TaskState,
} from "./types.js";

/** The A2A version the client speaks (`A2A-Version`). */
export const A2A_VERSION = "1.0";

/**
 * An error the agent answered in JSON-RPC: `code` is the JSON-RPC or A2A code (e.g. `-32001`
 * for a task that is not found), `reason` the `google.rpc.ErrorInfo` reason (e.g.
 * `TASK_NOT_FOUND`, `CONTEXT_BUSY`). HTTP-level refusals (`401`, `404` for an unknown agent,
 * `429`) are `RuntimeError`s, as everywhere in the SDK.
 */
export class A2aError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason: string | undefined,
    /** `google.rpc.ErrorInfo` metadata. */
    readonly metadata: Readonly<Record<string, string>> = {},
    /** The error's `data` as sent. */
    readonly data?: unknown
  ) {
    super(message);
    this.name = "A2aError";
  }
}

export interface A2aClientOptions {
  /** The agent's A2A endpoint, e.g. `${runtimeUrl}/v1/a2a/agents/${agentId}`. */
  url: string;
  /** A Nylorun application key, sent as `Authorization: Bearer`. */
  key?: string;
  /**
   * The subject the calls act for (`Nylorun-Subject`, with `Nylorun-Scopes`): its own
   * contexts and tasks only. Required by the Runtime with an application key, e.g.
   * `u:<org>:<user>`.
   */
  subject?: string;
  /** The subject's scopes. Default `["sessions:own"]`. */
  scopes?: readonly SubjectScope[];
  /** Sent on every request, e.g. a gateway's partner key. */
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  /** The extensions to activate (`A2A-Extensions`). Default: all five of profile v2. */
  extensions?: readonly string[];
  /**
   * Where the Agent Card is. Default: `${url}/card` for a Runtime's `/v1/a2a/agents/{id}`,
   * else `${url}/.well-known/agent-card.json` (the gateway's).
   */
  cardUrl?: string;
}

export interface A2aSendOptions {
  /** The idempotency key: a retried message answers with the same task. */
  messageId: string;
  /** Omit to start a new context. */
  contextId?: string;
  /** To continue an interrupted task. */
  taskId?: string;
  parts: Part[];
  metadata?: Metadata;
  /** The extension URIs whose data `metadata` carries (the message's `extensions`). */
  extensions?: string[];
  /**
   * What a message to a busy context does: `queue` (profile v2's default) is answered with the
   * task that will take it; `reject` is `A2aError` with reason `CONTEXT_BUSY`. Sent as
   * `metadata.delivery`.
   */
  delivery?: "queue" | "reject";
  /** Where the agent pushes this task's updates; verify each with `verifyA2aPush`. */
  push?: PushNotificationConfig;
  /** Answer at once with the task (`SUBMITTED` or `WORKING`) instead of waiting. */
  returnImmediately?: boolean;
  historyLength?: number;
  acceptedOutputModes?: string[];
  /** W3C trace context: the task joins the caller's trace. */
  traceparent?: string;
  signal?: AbortSignal;
}

export interface A2aListOptions {
  contextId?: string;
  status?: TaskState;
  /** ISO 8601: tasks whose status changed after this time. */
  statusTimestampAfter?: string;
  /** At most 100; the agent's default is 50. */
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  signal?: AbortSignal;
}

export interface A2aAnswerOptions {
  taskId: string;
  contextId: string;
  /** The `interactionId` from `readInteraction`. */
  interactionId: string;
  /** For an approval. */
  approved?: boolean;
  /** For a question. */
  value?: unknown;
  messageId: string;
  signal?: AbortSignal;
}

export interface A2aClient {
  readonly url: string;
  /** `SendMessage`: the task that runs (or will run) the message. */
  send(options: A2aSendOptions): Promise<Task>;
  /** `GetTask`. */
  get(taskId: string, options?: { historyLength?: number; signal?: AbortSignal }): Promise<Task>;
  /** `ListTasks`: one page of the caller's tasks, newest change first. */
  list(options?: A2aListOptions): Promise<ListTasksResult>;
  /** Every task `list` matches, page after page. */
  listAll(options?: Omit<A2aListOptions, "pageToken">): AsyncGenerator<Task>;
  /** `CancelTask`. */
  cancel(taskId: string, options?: { signal?: AbortSignal }): Promise<Task>;
  /**
   * Answers an open interaction (`interactions/v1`) on its task: `approved` for an approval or
   * a connection, `value` for a question.
   */
  answer(options: A2aAnswerOptions): Promise<Task>;
  /** The agent's card. */
  card(options?: { signal?: AbortSignal }): Promise<AgentCard>;
  /** One JSON-RPC call, for operations the client has no method for. */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal }
  ): Promise<T>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `A2aError` a JSON-RPC error object stands for, or `undefined` when it isn't one. */
function errorOf(body: unknown): A2aError | undefined {
  if (!isObject(body) || !isObject(body.error)) return undefined;
  const { code, message, data } = body.error;
  if (typeof code !== "number") return undefined;
  const info = Array.isArray(data)
    ? data.find(
        (entry): entry is Record<string, unknown> =>
          isObject(entry) && entry["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
      )
    : undefined;
  const metadata: Record<string, string> = {};
  if (info && isObject(info.metadata))
    for (const [name, value] of Object.entries(info.metadata))
      if (typeof value === "string") metadata[name] = value;
  return new A2aError(
    code,
    typeof message === "string" ? message : `A2A error ${code}`,
    info && typeof info.reason === "string" ? info.reason : undefined,
    metadata,
    data
  );
}

function fetcherOf(fetcher: typeof fetch | undefined): typeof fetch {
  // Called as a method on a page's window would otherwise lose `this`.
  return fetcher ?? ((input, init) => globalThis.fetch(input, init));
}

const RUNTIME_ENDPOINT = /\/v1\/a2a\/agents\/[^/]+$/;

export function createA2aClient(options: A2aClientOptions): A2aClient {
  const url = options.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new TypeError("createA2aClient: url must be an http(s) URL");
  const fetcher = fetcherOf(options.fetch);
  const base: Record<string, string> = {
    ...options.headers,
    ...requestHeaders(options.key),
    "A2A-Version": A2A_VERSION,
  };
  if (options.subject !== undefined) {
    const parsed = parseSubjectHeaders(
      options.subject,
      [...(options.scopes ?? ["sessions:own"])].join(" ")
    );
    if (!parsed.ok) throw new TypeError(parsed.message);
    base[SUBJECT_HEADER] = options.subject;
    base[SCOPES_HEADER] = [...parsed.scopes].join(" ");
  }
  const extensions = [...(options.extensions ?? A2A_PROFILE_EXTENSIONS)];
  if (extensions.length > 0) base["A2A-Extensions"] = extensions.join(", ");
  const cardUrl =
    options.cardUrl ??
    (RUNTIME_ENDPOINT.test(new URL(url).pathname) ? `${url}/card` : `${url}/.well-known/agent-card.json`);

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    init: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal } = {}
  ): Promise<T> {
    const response = await fetcher(url, {
      method: "POST",
      headers: { ...base, ...init.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      redirect: "error",
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const body = await readBody(response);
    // Some agents answer a JSON-RPC error with an HTTP error status: it is still an A2A error.
    const error = errorOf(body);
    if (error) throw error;
    if (!response.ok) throw new RuntimeError(response.status, body);
    if (!isObject(body) || !("result" in body))
      throw new A2aError(-32603, "The agent's answer is not a JSON-RPC response", undefined, {}, body);
    return body.result as T;
  }

  async function sendMessage(
    message: Message,
    options: Omit<A2aSendOptions, "messageId" | "parts" | "contextId" | "taskId" | "metadata" | "extensions" | "delivery">
  ): Promise<Task> {
    const configuration: Record<string, unknown> = {};
    if (options.returnImmediately !== undefined)
      configuration.returnImmediately = options.returnImmediately;
    if (options.push) configuration.taskPushNotificationConfig = { ...options.push };
    if (options.historyLength !== undefined) configuration.historyLength = options.historyLength;
    if (options.acceptedOutputModes)
      configuration.acceptedOutputModes = [...options.acceptedOutputModes];
    const result = await call<{ task?: Task; message?: Message }>(
      "SendMessage",
      { message, ...(Object.keys(configuration).length ? { configuration } : {}) },
      {
        ...(options.traceparent ? { headers: { traceparent: options.traceparent } } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
    );
    if (isObject(result) && isObject(result.task)) return result.task;
    throw new A2aError(
      -32603,
      "The agent answered with a message, not a task",
      undefined,
      {},
      result
    );
  }

  async function list(listOptions: A2aListOptions = {}): Promise<ListTasksResult> {
    const { signal, ...params } = listOptions;
    return call<ListTasksResult>("ListTasks", { ...params }, signal ? { signal } : {});
  }

  return {
    url,
    call,
    send(send) {
      const metadata = {
        ...send.metadata,
        ...(send.delivery ? { delivery: send.delivery } : {}),
      };
      return sendMessage(
        {
          messageId: send.messageId,
          role: "ROLE_USER",
          parts: send.parts,
          ...(send.contextId !== undefined ? { contextId: send.contextId } : {}),
          ...(send.taskId !== undefined ? { taskId: send.taskId } : {}),
          ...(send.extensions?.length ? { extensions: [...send.extensions] } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
        },
        send
      );
    },
    get(taskId, getOptions = {}) {
      return call<Task>(
        "GetTask",
        {
          id: taskId,
          ...(getOptions.historyLength !== undefined
            ? { historyLength: getOptions.historyLength }
            : {}),
        },
        getOptions.signal ? { signal: getOptions.signal } : {}
      );
    },
    list,
    async *listAll(listOptions = {}) {
      let pageToken: string | undefined;
      do {
        const page = await list({ ...listOptions, ...(pageToken ? { pageToken } : {}) });
        yield* page.tasks;
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
    },
    cancel(taskId, cancelOptions = {}) {
      return call<Task>(
        "CancelTask",
        { id: taskId },
        cancelOptions.signal ? { signal: cancelOptions.signal } : {}
      );
    },
    async answer(answer) {
      const hasApproval = answer.approved !== undefined;
      const hasValue = answer.value !== undefined;
      if (hasApproval === hasValue)
        throw new TypeError("answer: give exactly one of approved and value");
      const reply = hasApproval ? { approved: answer.approved } : { value: answer.value };
      return sendMessage(
        {
          messageId: answer.messageId,
          role: "ROLE_USER",
          taskId: answer.taskId,
          contextId: answer.contextId,
          parts: [{ data: reply }],
          extensions: [A2A_EXTENSIONS.interactions],
          metadata: {
            [A2A_EXTENSIONS.interactions]: { interactionId: answer.interactionId, ...reply },
          },
        },
        answer.signal ? { signal: answer.signal } : {}
      );
    },
    async card(cardOptions = {}) {
      const { "A2A-Extensions": _extensions, ...headers } = base;
      const response = await fetcher(cardUrl, {
        headers,
        redirect: "error",
        ...(cardOptions.signal ? { signal: cardOptions.signal } : {}),
      });
      const body = await readBody(response);
      if (!response.ok) throw new RuntimeError(response.status, body);
      return body as AgentCard;
    },
  };
}

/** One turn as the change feed lists it (Host feature `turns`). */
export interface TurnChange {
  turnId: string;
  sessionId: string;
  agentId: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  /** When it last changed: a turn reappears each time it changes. */
  changedAt: string;
  totals: { steps: number; tokens: number; costUsd: number } | null;
  /** The A2A context and task it is, when it came in over A2A. */
  a2a: { contextId: string; taskId: string } | null;
}

export interface TurnChangesPage {
  turns: TurnChange[];
  /** Pass as `changedAfter` next time; returned even when `turns` is empty. */
  cursor: string;
  hasMore: boolean;
}

export interface ListTurnChangesOptions {
  /** The Runtime's URL, e.g. `https://agents.example`. */
  baseUrl: string;
  /** An application key sees the whole Tenant; with `subject`, only that subject's sessions. */
  key: string;
  subject?: string;
  scopes?: readonly SubjectScope[];
  /** The `cursor` of the previous page. Omit to start from the beginning. */
  changedAfter?: string;
  /** One session's turns instead of the feed. */
  sessionId?: string;
  /** 1 to 500; the Runtime's default is 100. */
  limit?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * `GET /v1/turns`: the turns that changed after `changedAfter`, in the order they changed. Call
 * it on an interval with the last `cursor` to find what a lost push would have said.
 */
export async function listTurnChanges(options: ListTurnChangesOptions): Promise<TurnChangesPage> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl))
    throw new TypeError("listTurnChanges: baseUrl must be an http(s) URL");
  const query = new URLSearchParams();
  if (options.changedAfter !== undefined) query.set("changedAfter", options.changedAfter);
  if (options.sessionId !== undefined) query.set("sessionId", options.sessionId);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const headers: Record<string, string> = { ...requestHeaders(options.key) };
  if (options.subject !== undefined) {
    const parsed = parseSubjectHeaders(
      options.subject,
      [...(options.scopes ?? ["sessions:own"])].join(" ")
    );
    if (!parsed.ok) throw new TypeError(parsed.message);
    headers[SUBJECT_HEADER] = options.subject;
    headers[SCOPES_HEADER] = [...parsed.scopes].join(" ");
  }
  const search = query.size ? `?${query}` : "";
  const response = await fetcherOf(options.fetch)(`${baseUrl}/v1/turns${search}`, {
    headers,
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await readBody(response);
  if (!response.ok) throw new RuntimeError(response.status, body);
  return body as TurnChangesPage;
}
