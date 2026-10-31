/**
 * The A2A endpoint (Host features `a2a-endpoint` and `a2a-profile-v2`): `POST
 * /v1/a2a/agents/:agent` answers A2A 1.0 JSON-RPC for one subject, and `GET
 * /v1/a2a/agents/:agent/card` returns the agent's card. It serves `SendMessage` (blocking up to
 * `a2aWaitMs`, or `returnImmediately`), `GetTask`, `CancelTask` and the four push notification
 * config methods; every other operation answers with the error the specification defines for it
 * (docs: `implementation/a2a-implementation.md`, profile v2: `design/runtime/a2a-profile.md`).
 *
 * Every task operation goes through the session contract as the caller: `command` with the
 * caller's scope (limits and owner checks apply), sessions derived from the caller's own
 * subject, history from Durable Streams. A task id from the client only selects a context and
 * a turn within the caller's own sessions, so another subject's task is `TaskNotFoundError`.
 *
 * Profile v2:
 * - A message to a busy context is **queued** (`delivery: "queue"`, protocol 17) and answered
 *   with the task that will take it: `SUBMITTED`, its id the queued message's own until a turn
 *   takes it, then that turn's state. `metadata.delivery: "reject"` keeps v1's
 *   `UnsupportedOperationError` (reason `CONTEXT_BUSY`).
 * - An open interaction shows on the status message under `interactions/v1`; the caller answers
 *   on the same task with `{ interactionId, approved }` (the Runtime's `approve`, recorded with
 *   the caller as `approvedBy`) or `{ interactionId, value }` (`respond`). Text never approves.
 * - A push config (in `SendMessage`, or the config methods) sends the task's updates to the
 *   caller's URL (`push.ts`).
 * - A message's `raw` and `url` file parts are stored as artifacts of the context's session once
 *   it is open (`../inbound-files.ts`; a `url` is fetched under the push address policy), and the
 *   message goes in as `parts`. The files the turn writes come back as artifacts whose `url`
 *   parts point at `/v1/a2a/files/…`, served to the same subject, with `files/v1`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  SessionCommandSchema,
  type LiveEvent,
  type SessionCommand,
} from "@nylorun/core/contracts";
import { commandKey } from "../../core/flow-host.js";
import { contentTypeFor } from "@nylorun/core/contracts";
import {
  discardFiles,
  fetchUrlFile,
  inlineFileName,
  messageParts,
  type InboundPart,
} from "../inbound-files.js";
import { agentCard, inputModesFor, type CardDefinition } from "./card.js";
import { keepExtensions } from "./extensions.js";
import {
  A2aError,
  a2aFail,
  checkVersion,
  jsonRpcError,
  jsonRpcResult,
  parseCreatePushParams,
  parseEnvelope,
  parseListPushParams,
  parsePushConfigRef,
  parseSendParams,
  parseTaskParams,
  type InteractionAnswer,
  type JsonRpcRequest,
  type MessageInput,
  type PushConfigInput,
  type SendParams,
  type Task,
  type TaskPushNotificationConfig,
} from "./protocol.js";
import {
  configView,
  kickPushes,
  pushEnabled,
  pushPolicy,
  savePushConfig,
  type PushStart,
} from "./push.js";
import {
  ENDED,
  SETTLED_EVENTS,
  buildTask,
  callerTraceId,
  contextSessionId,
  newContextId,
  parseTaskId,
  pendingInteraction,
  pendingInteractions,
  submittedTask,
  taskIdOf,
  type PendingInteraction,
} from "./tasks.js";
import { currentModelDescriptor } from "../../model/descriptor.js";
import { decodeCursor } from "../../record/cursor.js";
import { accessOf } from "../../tenant/auth.js";
import { command } from "../../tenant/commands.js";
import {
  loadSession,
  reachesAgent,
  type AuthScope,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "../../tenant/context.js";
import { agentGrantsOf, liveEnvironment } from "../../tenant/agents.js";
import { HttpError, fail } from "../../tenant/http.js";
import { observeSession, readHistory } from "../../tenant/session-streams.js";
import { putSession } from "../../tenant/sessions.js";
import { readRuntimeLimits } from "../../tenant/runtime-limits.js";
import { traceKey } from "../../traces/key.js";
import { parseTraceparent, traceIdOf, type TraceContext } from "../../traces/ids.js";

/** The caller of one A2A request: a subject, limited to its own sessions of one agent. */
interface Caller {
  readonly ctx: TenantContext;
  readonly scope: AuthScope;
  readonly access: SessionAccess;
  readonly agentId: string;
  /** The request's trace context (R7.4): a message's turn joins the caller's trace. */
  readonly trace?: TraceContext;
  /** The profile extensions the request activated (`A2A-Extensions`). */
  readonly extensions: ReadonlySet<string>;
  /** The Runtime's URL as the caller reaches it: file URLs and push configs start from it. */
  readonly baseUrl: string;
}

/** A task the caller owns, with the session it lives in. */
interface OwnedTask {
  readonly task: Task;
  readonly session: Session;
  readonly sessionId: string;
  readonly contextId: string;
  /** The turn the task is: a queued message's id while it waits (`queued`). */
  readonly turnId: string;
  /** The task's events, in stream order. */
  readonly events: readonly LiveEvent[];
  /** Set while the task is a queued message no turn took yet. */
  readonly queued?: LiveEvent;
}

/** The A2A endpoint's route for a published agent, from the Runtime's base URL. */
export function agentEndpoint(baseUrl: string, agentId: string): string {
  return `${baseUrl}/v1/a2a/agents/${encodeURIComponent(agentId)}`;
}

/**
 * `GET /v1/a2a/agents/:agent/card`: the agent's card, for a caller who may use the agent. Its
 * input modes name the files the Tenant's model reads natively: a hint, since any file is
 * accepted and the agent's harness decides how its model sees it (protocol 15). Its interface is
 * this Runtime's JSON-RPC endpoint at `baseUrl` (a gateway lists its own instead).
 */
export async function a2aCard(
  ctx: TenantContext,
  scope: AuthScope,
  agentId: string,
  baseUrl: string
): Promise<unknown> {
  const definition = await definitionFor(ctx, agentId, accessOf(scope));
  // The files the Tenant's model reads now.
  return agentCard(agentId, definition, inputModesFor((await currentModelDescriptor(ctx))?.inputs), {
    url: agentEndpoint(baseUrl, agentId),
    pushNotifications: pushEnabled(ctx),
  });
}

/**
 * `POST /v1/a2a/agents/:agent`: one A2A JSON-RPC call, for a subject. JSON-RPC answers (errors
 * included) are the body to send with 200, without the data of extensions the request did not
 * activate; HTTP-level refusals (unknown agent, no subject, limits) are thrown as `HttpError`
 * like any Tenant route. `body` is read once the agent is known to be the caller's; closing
 * `response` stops a blocking wait, never the task.
 */
export async function a2aCall(
  ctx: TenantContext,
  scope: AuthScope,
  agentId: string,
  input: {
    body: () => Promise<string>;
    version: string | null;
    trace?: TraceContext;
    extensions: ReadonlySet<string>;
    baseUrl: string;
  },
  response: ServerResponse
): Promise<unknown> {
  const access = accessOf(scope);
  if (!access)
    return fail(400, "Acting for a subject is required: send Nylorun-Subject and Nylorun-Scopes", {
      code: "subject_required",
    });
  await definitionFor(ctx, agentId, access);
  const envelope = parseEnvelope(await input.body());
  if (!envelope.ok) return jsonRpcError(envelope.id, envelope.error);
  // A blocking call stops waiting when the caller hangs up; the task keeps running.
  const hangup = new AbortController();
  response.on("close", () => hangup.abort());
  const caller: Caller = {
    ctx,
    scope,
    access,
    agentId,
    ...(input.trace ? { trace: input.trace } : {}),
    extensions: input.extensions,
    baseUrl: input.baseUrl,
  };
  const { id } = envelope.request;
  try {
    checkVersion(input.version);
    const result = await operation(caller, envelope.request, hangup.signal);
    return jsonRpcResult(id, keepExtensions(result, input.extensions));
  } catch (error) {
    if (error instanceof A2aError) return jsonRpcError(id, error);
    // Limits, scopes and unavailable streams stay HTTP answers, as on every Tenant route.
    if (error instanceof HttpError && [403, 413, 429, 503].includes(error.status)) throw error;
    ctx.config.logger.warn("a2a request failed", {
      agentId,
      method: envelope.request.method,
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcError(id, new A2aError("internal", "Internal error"));
  }
}

async function operation(
  caller: Caller,
  request: JsonRpcRequest,
  signal: AbortSignal
): Promise<unknown> {
  switch (request.method) {
    case "SendMessage":
      return sendMessage(caller, request.params, signal);
    case "GetTask": {
      const params = parseTaskParams(request.params);
      return (await ownedTask(caller, params.id, params.historyLength)).task;
    }
    case "CancelTask":
      return cancelTask(caller, parseTaskParams(request.params).id);
    case "ListTasks":
      return a2aFail("unsupportedOperation", "ListTasks is not supported by this agent yet");
    case "SendStreamingMessage":
    case "SubscribeToTask":
      return a2aFail(
        "unsupportedOperation",
        "Streaming is not supported: the Agent Card declares capabilities.streaming false; register a push notification config"
      );
    case "CreateTaskPushNotificationConfig":
      return createPushConfig(caller, request.params);
    case "GetTaskPushNotificationConfig":
      return getPushConfig(caller, request.params);
    case "ListTaskPushNotificationConfigs":
      return listPushConfigs(caller, request.params);
    case "DeleteTaskPushNotificationConfig":
      return deletePushConfig(caller, request.params);
    case "GetExtendedAgentCard":
      return a2aFail("unsupportedOperation", "This agent has no extended Agent Card");
    default:
      return a2aFail("methodNotFound", `Method ${request.method} not found`);
  }
}

/**
 * What the card of Agent `agentId` says (the manifest version it runs), or a `404` when it is
 * missing or the caller may not use it. Every caller's session runs on that Agent, with its disk
 * and vault (D66, D70): an app that serves several audiences makes an Agent for each.
 */
async function definitionFor(
  ctx: TenantContext,
  agentId: string,
  access: SessionAccess | undefined
): Promise<CardDefinition> {
  if (!reachesAgent(access, agentId)) return fail(404, "Agent not found");
  return ctx.store.tx(async (t) => {
    const agent = (await liveEnvironment(t, agentId)) ?? fail(404, "Agent not found");
    const version = await t.agentManifest(agent.manifestName, agent.manifestVersion);
    return {
      manifest: { id: agentId, ...(version?.body.description === undefined ? {} : { description: version.body.description }) },
      version: `${agent.manifestName}@${agent.manifestVersion}`,
    };
  });
}

const taskNotFound = (taskId: string): never =>
  a2aFail("taskNotFound", "Task not found", { taskId });

/** The caller's session for a context, or undefined when it does not exist yet. */
async function contextSession(
  caller: Caller,
  sessionId: string
): Promise<Session | undefined> {
  try {
    return await loadSession(caller.ctx, sessionId, caller.access);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

/** Every event of a session, in stream order. */
async function sessionEvents(ctx: TenantContext, sessionId: string): Promise<LiveEvent[]> {
  return (await readHistory(ctx, sessionId, undefined, undefined)).items;
}

/** `telemetry/v1`'s trace id for a turn: the caller's `traceparent`'s, else the Runtime's own. */
async function turnTraceId(
  ctx: TenantContext,
  sessionId: string,
  turnId: string,
  events: readonly LiveEvent[]
): Promise<string> {
  return callerTraceId(events) ?? traceIdOf(await traceKey(ctx.store), ctx.store.tenantId, sessionId, turnId);
}

const payloadOf = (event: LiveEvent) => (event.payload ?? {}) as Record<string, unknown>;

/**
 * The caller's task `taskId`. Its last part is a turn, or a queued message's id: while the
 * message waits the task is `SUBMITTED`, and once a turn took it (its `command.message` names
 * the message) the task is that turn's, under the id the caller knows.
 */
async function ownedTask(
  caller: Caller,
  taskId: string,
  historyLength?: number
): Promise<OwnedTask> {
  const ids = parseTaskId(taskId) ?? taskNotFound(taskId);
  const sessionId = contextSessionId(caller.access.owner, caller.agentId, ids.contextId);
  const session = (await contextSession(caller, sessionId)) ?? taskNotFound(taskId);
  const all = await sessionEvents(caller.ctx, sessionId);
  let turnId = ids.turnId;
  let events = all.filter((event) => event.turnId === turnId);
  if (events.length === 0 && session.activeTurnId !== turnId && session.lastTurnId !== turnId) {
    const taken = all.find(
      (event) => event.type === "command.message" && event.turnId && payloadOf(event).queuedMessageId === ids.turnId
    );
    if (taken) {
      turnId = taken.turnId!;
      events = all.filter((event) => event.turnId === turnId);
    } else {
      const queued = all.find(
        (event) => event.type === "message.queued" && payloadOf(event).queuedMessageId === ids.turnId
      );
      if (queued)
        return {
          task: submittedTask(ids.contextId, taskId, queued),
          session,
          sessionId,
          contextId: ids.contextId,
          turnId: ids.turnId,
          events: [],
          queued,
        };
    }
  }
  const ended = events.some((event) => ENDED.has(event.type));
  const task =
    buildTask({
      contextId: ids.contextId,
      turnId,
      taskId,
      session,
      events,
      baseUrl: caller.baseUrl,
      ...(ended ? { traceId: await turnTraceId(caller.ctx, sessionId, turnId, events) } : {}),
      ...(historyLength !== undefined ? { historyLength } : {}),
    }) ?? taskNotFound(taskId);
  return { task, session, sessionId, contextId: ids.contextId, turnId, events };
}

/** What a session command answered: a turn that took it, or the queue it waits in. */
type Accepted =
  | { turnId: string; cursor: string; queuedMessageId?: undefined }
  | { queuedMessageId: string; cursor: string; turnId?: undefined };

/** Runs a session command as the caller, mapping the Runtime's refusals to A2A errors. */
async function run(
  caller: Caller,
  sessionId: string,
  input: SessionCommand,
  /** The error for a `409` conflict: the session is busy or no longer waiting. */
  conflict: () => Promise<A2aError>,
  /** What a message to a busy session does: queued (profile v2), or `409`. */
  delivery: "queue" | "reject" = "reject"
): Promise<Accepted> {
  try {
    const accepted = (await command(
      caller.ctx,
      sessionId,
      SessionCommandSchema.parse(input),
      caller.scope,
      { ...(caller.trace ? { trace: caller.trace } : {}), delivery }
    )) as { status: string; turnId?: string | null; queuedMessageId?: string; cursor: string };
    return accepted.status === "queued"
      ? { queuedMessageId: accepted.queuedMessageId!, cursor: accepted.cursor }
      : { turnId: accepted.turnId!, cursor: accepted.cursor };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status !== 409) throw error;
    if (error.message.startsWith("Idempotency key"))
      return a2aFail(
        "invalidParams",
        "message.messageId was already used for a different message",
        {},
        "message.messageId"
      );
    throw await conflict();
  }
}

/** Opens the caller's session for a context: created when missing, never changed after. */
async function openContext(caller: Caller, sessionId: string): Promise<Session> {
  const existing = await contextSession(caller, sessionId);
  if (existing) return existing;
  return putSession(
    caller.ctx,
    sessionId,
    {
      requestId: randomUUID(),
      agent: caller.agentId,
      ownerUserId: caller.access.owner,
    },
    caller.access,
    agentGrantsOf(caller.scope) === undefined ? {} : { agentGrants: agentGrantsOf(caller.scope)! }
  );
}

async function sendMessage(
  caller: Caller,
  params: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ task: Task }> {
  const send = parseSendParams(params);
  if (send.push && !pushEnabled(caller.ctx))
    a2aFail("pushNotSupported", "Push notifications are not configured on this Runtime");
  const idempotencyKey = `a2a:${send.messageId}`;
  let contextId: string;
  let sessionId: string;
  let accepted: Accepted;
  if (send.taskId !== undefined) {
    const ids = parseTaskId(send.taskId) ?? taskNotFound(send.taskId);
    if (send.contextId !== undefined && send.contextId !== ids.contextId)
      a2aFail(
        "invalidParams",
        "message.contextId does not match the task's context",
        {},
        "message.contextId"
      );
    contextId = ids.contextId;
    const owned = await ownedTask(caller, send.taskId, 0);
    sessionId = owned.sessionId;
    accepted = await reply(caller, send, owned, idempotencyKey);
  } else {
    contextId =
      send.contextId ?? newContextId(caller.access.owner, caller.agentId, send.messageId);
    sessionId = contextSessionId(caller.access.owner, caller.agentId, contextId);
    await openContext(caller, sessionId);
    const context = contextId;
    const { body, stored } = await messageBody(caller, sessionId, idempotencyKey, send.input);
    accepted = await run(
      caller,
      sessionId,
      {
        type: "message",
        requestId: randomUUID(),
        idempotencyKey,
        ...body,
      } as SessionCommand,
      async () => {
        const active = (await contextSession(caller, sessionId))?.activeTurnId;
        const taskId = active ? taskIdOf(context, active) : undefined;
        return taskId
          ? new A2aError(
              "unsupportedOperation",
              `The context has a task in progress (${taskId}); reply to it, cancel it, or send without delivery "reject" to queue the message`,
              { taskId },
              undefined,
              "CONTEXT_BUSY"
            )
          : new A2aError(
              "unsupportedOperation",
              "The context has unresolved work; start a new context",
              {},
              undefined,
              "CONTEXT_BUSY"
            );
      },
      send.delivery
    ).catch(async (error: unknown) => {
      await discardFiles(caller.ctx, stored, caller.access);
      throw error;
    });
  }
  const turnId = accepted.turnId ?? accepted.queuedMessageId!;
  const taskId = send.taskId ?? taskIdOf(contextId, turnId);
  if (send.push)
    await registerPush(caller, send.push, {
      sessionId,
      contextId,
      taskId,
      turnId: accepted.turnId ?? accepted.queuedMessageId!,
      nextSeq: decodeCursor(sessionId, accepted.cursor),
      ...(accepted.turnId !== undefined ? { traceId: await sendTraceId(caller, sessionId, accepted.turnId) } : {}),
    });
  if (!send.returnImmediately)
    await settled(caller.ctx, sessionId, accepted, signal);
  const { task } = await ownedTask(caller, taskId, send.historyLength);
  return { task };
}

/** The trace id of a turn this request started: its `traceparent`'s, else the Runtime's own. */
async function sendTraceId(caller: Caller, sessionId: string, turnId: string): Promise<string> {
  const parsed = caller.trace ? parseTraceparent(caller.trace.traceparent) : undefined;
  return parsed?.traceId ?? traceIdOf(await traceKey(caller.ctx.store), caller.ctx.store.tenantId, sessionId, turnId);
}

/**
 * A message on an existing task: an answer to one of its open interactions (`interactions/v1`),
 * or a text or data reply to the question it waits on. A retried answer replays through
 * `command`, which compares it with the first one.
 */
async function reply(
  caller: Caller,
  send: SendParams,
  owned: OwnedTask,
  idempotencyKey: string
): Promise<Accepted> {
  const { session, sessionId, turnId } = owned;
  const taskId = owned.task.id;
  const prior = await caller.ctx.store.tx((t) =>
    t.get<{ command: SessionCommand }>("commands", commandKey(sessionId, idempotencyKey))
  );
  const reused = () =>
    a2aFail(
      "invalidParams",
      "message.messageId was already used for a different message",
      {},
      "message.messageId"
    );
  let answer: SessionCommand;
  if (send.answer) {
    const kind =
      prior?.command.type === "approve" || prior?.command.type === "respond"
        ? prior.command.type
        : prior
        ? reused()
        : answerTarget(owned, send.answer).engineKind === "approval"
        ? "approve"
        : "respond";
    answer = answerCommand(kind, send.answer, idempotencyKey);
  } else {
    const value =
      "content" in send.input
        ? send.input.content
        : "data" in send.input
        ? send.input.data
        : a2aFail(
            "contentTypeNotSupported",
            "A reply takes text or one data part; send files in a new message",
            { accepted: "text/plain,application/json" }
          );
    const interactionId =
      prior?.command.type === "respond"
        ? prior.command.interactionId
        : prior
        ? reused()
        : replyTarget(owned);
    answer = { type: "respond", requestId: randomUUID(), idempotencyKey, interactionId, value } as SessionCommand;
  }
  const accepted = await run(
    caller,
    sessionId,
    answer,
    async () =>
      new A2aError("unsupportedOperation", "The task is no longer waiting for input", { taskId })
  );
  return { turnId, cursor: accepted.cursor };
}

/**
 * The command an `interactions/v1` answer is: `approve` with `approved`, or `respond` with
 * `value` (an `approved` answer to a question or connection is its value).
 */
function answerCommand(
  kind: "approve" | "respond",
  answer: InteractionAnswer,
  idempotencyKey: string
): SessionCommand {
  const base = { requestId: randomUUID(), idempotencyKey, interactionId: answer.interactionId };
  if (kind === "approve") {
    const approved =
      "approved" in answer
        ? answer.approved
        : typeof answer.value === "boolean"
        ? answer.value
        : a2aFail("invalidParams", "An approval is answered with approved: true or false", {}, "message.metadata");
    return { type: "approve", ...base, approved } as SessionCommand;
  }
  return {
    type: "respond",
    ...base,
    value: "approved" in answer ? answer.approved : (answer.value ?? null),
  } as SessionCommand;
}

/** A reply to a task that is not active: it is queued, or in a terminal state. */
function notActive(owned: OwnedTask): never {
  const taskId = owned.task.id;
  if (owned.queued)
    return a2aFail("unsupportedOperation", "The task is queued and waits for nothing yet", { taskId });
  return a2aFail(
    "unsupportedOperation",
    "The task is in a terminal state and accepts no more messages; send a new message without taskId",
    { taskId }
  );
}

/** The task must be active and waiting on the interaction the answer names. */
function answerTarget(owned: OwnedTask, answer: InteractionAnswer): PendingInteraction {
  const { session } = owned;
  if (owned.queued || session.activeTurnId !== owned.turnId) return notActive(owned);
  const open = session.status === "paused" ? pendingInteractions(session) : [];
  return (
    open.find((interaction) => interaction.id === answer.interactionId) ??
    a2aFail(
      "invalidParams",
      open.length === 0
        ? "The task is not waiting for an answer"
        : `The task does not wait on interaction ${answer.interactionId}`,
      { taskId: owned.task.id },
      "message.metadata"
    )
  );
}

/**
 * A new message's body: its text, its JSON value, or parts with its `raw` and `url` files stored
 * as artifacts of the session (`stored`: the ones this call created). A file the Runtime cannot
 * fetch or store is `InvalidParamsError`; one past a limit stays an HTTP `413`.
 */
async function messageBody(
  caller: Caller,
  sessionId: string,
  idempotencyKey: string,
  input: MessageInput
): Promise<{ body: Record<string, unknown>; stored: string[] }> {
  if (!("files" in input)) return { body: input, stored: [] };
  try {
    let files = 0;
    const inbound: InboundPart[] = [];
    for (const part of input.files) {
      if ("text" in part) {
        inbound.push({ type: "text", text: part.text });
        continue;
      }
      const index = files++;
      if ("url" in part) {
        inbound.push({
          type: "inline",
          ...(await fetchUrlFile(
            caller.ctx,
            part.url,
            {
              ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
              ...(part.filename !== undefined ? { filename: part.filename } : {}),
            },
            pushPolicy(caller.ctx, part.url)
          )),
        });
        continue;
      }
      const mediaType =
        part.mediaType ?? (part.filename !== undefined ? contentTypeFor(part.filename) : "application/octet-stream");
      inbound.push({
        type: "inline",
        name: part.filename ?? inlineFileName(mediaType, index),
        mediaType,
        data: part.raw,
      });
    }
    const { parts, stored } = await messageParts(
      caller.ctx,
      sessionId,
      idempotencyKey,
      inbound,
      caller.access
    );
    return { body: { parts }, stored };
  } catch (error) {
    if (error instanceof HttpError && error.status === 400)
      return a2aFail("invalidParams", error.message, {}, "message.parts");
    throw error;
  }
}

/**
 * The question a text or data reply answers: the task must be active and paused on one. An
 * approval takes only an `interactions/v1` answer: text never approves (profile v2 §1).
 */
function replyTarget(owned: OwnedTask): string {
  const { session } = owned;
  const taskId = owned.task.id;
  if (owned.queued || session.activeTurnId !== owned.turnId) return notActive(owned);
  const pending = session.status === "paused" ? pendingInteraction(session) : undefined;
  if (!pending)
    return a2aFail(
      "unsupportedOperation",
      "The task is working and not waiting for input; wait for it or cancel it",
      { taskId }
    );
  if (pending.engineKind === "approval")
    return a2aFail(
      "unsupportedOperation",
      "The task waits for an approval, which text never gives: answer it under the interactions/v1 extension ({ interactionId, approved }), or cancel the task",
      { taskId, interactionId: pending.id }
    );
  return pending.id;
}

async function cancelTask(caller: Caller, taskId: string): Promise<Task> {
  const owned = await ownedTask(caller, taskId);
  if (owned.queued)
    return a2aFail("taskNotCancelable", "The task is queued and starts when the context's running task ends; cancel it then", {
      taskId,
      state: owned.task.status.state,
    });
  if (owned.session.activeTurnId !== owned.turnId) {
    if (owned.task.status.state === "TASK_STATE_CANCELED") return owned.task;
    return a2aFail("taskNotCancelable", "The task has already finished and cannot be canceled", {
      taskId,
      state: owned.task.status.state,
    });
  }
  try {
    await command(
      caller.ctx,
      owned.sessionId,
      {
        type: "cancel",
        requestId: randomUUID(),
        idempotencyKey: `a2a-cancel:${owned.turnId}`,
        reason: "Canceled by the A2A client",
      },
      caller.scope
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }
  return (await ownedTask(caller, taskId)).task;
}

// ---------------------------------------------------------------------------
// Push notification configs

/** A config's id when the caller names none: one per task. */
const DEFAULT_PUSH_CONFIG = "default";

/** Stores a push config for a task this request started or answered, then pumps the session. */
async function registerPush(
  caller: Caller,
  config: PushConfigInput,
  start: Omit<PushStart, "baseUrl" | "extensions">
): Promise<TaskPushNotificationConfig> {
  const configId = config.id ?? DEFAULT_PUSH_CONFIG;
  const saved = await caller.ctx.store.tx(async (t) => {
    // A retried message keeps its config where it is, so updates are not sent again.
    const existing = await t.pushConfig(start.sessionId, start.taskId, configId);
    if (existing && sameConfig(existing, config)) return configView(existing);
    return savePushConfig(
      caller.ctx,
      t,
      { ...start, baseUrl: caller.baseUrl, extensions: caller.extensions },
      config,
      configId
    );
  });
  void kickPushes(caller.ctx, start.sessionId);
  return saved;
}

function sameConfig(
  row: { url: string; token: string | null; authentication: unknown },
  config: PushConfigInput
): boolean {
  return (
    row.url === config.url &&
    (row.token ?? undefined) === config.token &&
    JSON.stringify(row.authentication ?? null) === JSON.stringify(config.authentication ?? null)
  );
}

function requirePush(caller: Caller): void {
  if (!pushEnabled(caller.ctx))
    a2aFail("pushNotSupported", "Push notifications are not configured on this Runtime");
}

/**
 * `CreateTaskPushNotificationConfig`: from the task's next event on. A config on a finished task
 * is stored and sends nothing.
 */
async function createPushConfig(
  caller: Caller,
  params: Record<string, unknown>
): Promise<TaskPushNotificationConfig> {
  requirePush(caller);
  const { taskId, config } = parseCreatePushParams(params);
  const owned = await ownedTask(caller, taskId);
  const last = owned.queued ?? owned.events.at(-1);
  const ended = owned.events.some((event) => ENDED.has(event.type));
  const configId =
    config.id ?? createHash("sha256").update(`${config.url}\u0000${config.token ?? ""}`).digest("hex").slice(0, 16);
  return registerPush(
    caller,
    { ...config, id: configId },
    {
      sessionId: owned.sessionId,
      contextId: owned.contextId,
      taskId: owned.task.id,
      turnId: owned.turnId,
      nextSeq: last ? last.seq + 1 : 0,
      ...(owned.queued ? {} : { traceId: await turnTraceId(caller.ctx, owned.sessionId, owned.turnId, owned.events) }),
      done: ended,
    }
  );
}

async function getPushConfig(
  caller: Caller,
  params: Record<string, unknown>
): Promise<TaskPushNotificationConfig> {
  requirePush(caller);
  const ref = parsePushConfigRef(params);
  const owned = await ownedTask(caller, ref.taskId, 0);
  const row = await caller.ctx.store.tx((t) => t.pushConfig(owned.sessionId, owned.task.id, ref.id));
  return row ? configView(row) : a2aFail("taskNotFound", "Push notification config not found", { taskId: ref.taskId, id: ref.id });
}

async function listPushConfigs(
  caller: Caller,
  params: Record<string, unknown>
): Promise<{ configs: TaskPushNotificationConfig[]; nextPageToken: string }> {
  requirePush(caller);
  const query = parseListPushParams(params);
  const owned = await ownedTask(caller, query.taskId, 0);
  let after: string | undefined;
  if (query.pageToken !== undefined) {
    after = Buffer.from(query.pageToken, "base64url").toString("utf8");
    if (after === "") a2aFail("invalidParams", "pageToken is not one this agent issued", {}, "pageToken");
  }
  const rows = await caller.ctx.store.tx((t) =>
    t.pushConfigs(owned.sessionId, owned.task.id, { ...(after !== undefined ? { after } : {}), limit: query.pageSize + 1 })
  );
  const page = rows.slice(0, query.pageSize);
  return {
    configs: page.map(configView),
    nextPageToken:
      rows.length > query.pageSize ? Buffer.from(page.at(-1)!.configId, "utf8").toString("base64url") : "",
  };
}

async function deletePushConfig(caller: Caller, params: Record<string, unknown>): Promise<Record<string, never>> {
  requirePush(caller);
  const ref = parsePushConfigRef(params);
  const owned = await ownedTask(caller, ref.taskId, 0);
  const deleted = await caller.ctx.store.tx((t) => t.deletePushConfig(owned.sessionId, owned.task.id, ref.id));
  if (!deleted) a2aFail("taskNotFound", "Push notification config not found", { taskId: ref.taskId, id: ref.id });
  return {};
}

/**
 * Waits until the task's turn ends, pauses or has an uncertain effect, the caller hangs up, or
 * the Tenant's Runtime limit `a2aWaitMs` passes: after it, the task is returned as it is
 * (`WORKING`, or `SUBMITTED` while queued) and keeps running, and the caller polls `GetTask` or
 * waits for pushes. A queued message's task is followed to the turn that takes it. Follows the
 * session's shared stream from the command's cursor, so the events the task is built from are
 * there when it returns. A feed that ends (reset, deleted, closing) ends the wait: the task says
 * what the session says then.
 */
async function settled(
  ctx: TenantContext,
  sessionId: string,
  accepted: Accepted,
  signal: AbortSignal
): Promise<void> {
  const stop = new AbortController();
  const { a2aWaitMs } = await ctx.store.tx((t) => readRuntimeLimits(t));
  const timer = setTimeout(() => stop.abort(), a2aWaitMs);
  timer.unref();
  const hangup = () => stop.abort();
  signal.addEventListener("abort", hangup, { once: true });
  if (signal.aborted) stop.abort();
  let turnId = accepted.turnId;
  try {
    for await (const event of observeSession(ctx, sessionId, accepted.cursor, {
      signal: stop.signal,
    })) {
      if (
        turnId === undefined &&
        event.type === "command.message" &&
        event.turnId &&
        payloadOf(event).queuedMessageId === accepted.queuedMessageId
      )
        turnId = event.turnId;
      if (turnId !== undefined && event.turnId === turnId && SETTLED_EVENTS.has(event.type)) return;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", hangup);
  }
}
