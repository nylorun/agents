/**
 * The A2A endpoint (Host feature `a2a-endpoint`): `POST /v1/a2a/agents/:agent` answers A2A 1.0
 * JSON-RPC for one subject, and `GET /v1/a2a/agents/:agent/card` returns the agent's card
 * without interfaces. v1 serves `SendMessage` (blocking, or `returnImmediately`), `GetTask`
 * and `CancelTask`; every other operation answers with the error the specification defines
 * for it (docs: `implementation/a2a-implementation.md`).
 *
 * Every task operation goes through the session contract as the caller: `command` with the
 * caller's scope (limits and owner checks apply), sessions derived from the caller's own
 * subject, history from Durable Streams. A task id from the client only selects a context and
 * a turn within the caller's own sessions, so another subject's task is `TaskNotFoundError`.
 */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  SessionCommandSchema,
  type LiveEvent,
  type SessionCommand,
} from "@nylorun/core/contracts";
import { commandKey } from "../../core/flow-host.js";
import { agentCard, type CardDefinition } from "./card.js";
import {
  A2aError,
  a2aFail,
  checkVersion,
  jsonRpcError,
  jsonRpcResult,
  parseEnvelope,
  parseSendParams,
  parseTaskParams,
  type JsonRpcRequest,
  type Task,
} from "./protocol.js";
import {
  SETTLED_EVENTS,
  buildTask,
  contextSessionId,
  newContextId,
  parseTaskId,
  pendingInteraction,
  taskIdOf,
} from "./tasks.js";
import { accessOf } from "../../tenant/auth.js";
import { command } from "../../tenant/commands.js";
import {
  loadSession,
  type AuthScope,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "../../tenant/context.js";
import { HttpError, fail } from "../../tenant/http.js";
import { observeSession, readHistory } from "../../tenant/live.js";
import { putSession } from "../../tenant/sessions.js";

/**
 * How long a blocking `SendMessage` waits for the task to end or ask for input. After it, the
 * task is returned `WORKING` and keeps running; the caller polls `GetTask`.
 */
export const A2A_BLOCKING_WAIT_MS = 5 * 60_000;

/** The caller of one A2A request: a subject, limited to its own sessions of one agent. */
interface Caller {
  readonly ctx: TenantContext;
  readonly scope: AuthScope;
  readonly access: SessionAccess;
  readonly agentId: string;
}

/** A task the caller owns, with the session it lives in. */
interface OwnedTask {
  readonly task: Task;
  readonly session: Session;
  readonly sessionId: string;
  readonly contextId: string;
  readonly turnId: string;
}

/** `GET /v1/a2a/agents/:agent/card`: the agent's card, for a caller who may use the agent. */
export async function a2aCard(
  ctx: TenantContext,
  scope: AuthScope,
  agentId: string
): Promise<unknown> {
  return agentCard(agentId, await definitionFor(ctx, agentId, accessOf(scope)));
}

/**
 * `POST /v1/a2a/agents/:agent`: one A2A JSON-RPC call, for a subject. JSON-RPC answers (errors
 * included) are the body to send with 200; HTTP-level refusals (unknown agent, no subject,
 * limits) are thrown as `HttpError` like any Tenant route. `body` is read once the agent is
 * known to be the caller's; closing `response` stops a blocking wait, never the task.
 */
export async function a2aCall(
  ctx: TenantContext,
  scope: AuthScope,
  agentId: string,
  input: { body: () => Promise<string>; version: string | null },
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
  const caller: Caller = { ctx, scope, access, agentId };
  const { id } = envelope.request;
  try {
    checkVersion(input.version);
    return jsonRpcResult(id, await operation(caller, envelope.request, hangup.signal));
  } catch (error) {
    if (error instanceof A2aError) return jsonRpcError(id, error);
    // Limits, scopes and unavailable streams stay HTTP answers, as on every Tenant route.
    if (error instanceof HttpError && [403, 429, 503].includes(error.status)) throw error;
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
        "Streaming is not supported: the Agent Card declares capabilities.streaming false"
      );
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
      return a2aFail("pushNotSupported", "Push notifications are not supported");
    case "GetExtendedAgentCard":
      return a2aFail("unsupportedOperation", "This agent has no extended Agent Card");
    default:
      return a2aFail("methodNotFound", `Method ${request.method} not found`);
  }
}

/** The agent's definition, or a `404` when it is missing or the caller may not use it. */
async function definitionFor(
  ctx: TenantContext,
  agentId: string,
  access: SessionAccess | undefined
): Promise<CardDefinition> {
  if (access?.agents !== undefined && !access.agents.has(agentId))
    return fail(404, "Agent not found");
  const definition = await ctx.store.tx((t) =>
    t.get<CardDefinition>("definitions", agentId)
  );
  return definition ?? fail(404, "Agent not found");
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

/** The events of one turn, in stream order. */
async function turnEvents(
  ctx: TenantContext,
  sessionId: string,
  turnId: string
): Promise<LiveEvent[]> {
  const { items } = await readHistory(ctx, sessionId, undefined, undefined);
  return items.filter((event) => event.turnId === turnId);
}

async function ownedTask(
  caller: Caller,
  taskId: string,
  historyLength?: number
): Promise<OwnedTask> {
  const ids = parseTaskId(taskId) ?? taskNotFound(taskId);
  const sessionId = contextSessionId(caller.access.owner, caller.agentId, ids.contextId);
  const session = (await contextSession(caller, sessionId)) ?? taskNotFound(taskId);
  const task =
    buildTask({
      ...ids,
      session,
      events: await turnEvents(caller.ctx, sessionId, ids.turnId),
      ...(historyLength !== undefined ? { historyLength } : {}),
    }) ?? taskNotFound(taskId);
  return { task, session, sessionId, ...ids };
}

/** Runs a session command as the caller, mapping the Runtime's refusals to A2A errors. */
async function run(
  caller: Caller,
  sessionId: string,
  input: SessionCommand,
  /** The error for a `409` conflict: the session is busy or no longer waiting. */
  conflict: () => Promise<A2aError>
): Promise<{ turnId: string; cursor: string }> {
  try {
    const accepted = (await command(
      caller.ctx,
      sessionId,
      SessionCommandSchema.parse(input),
      caller.scope
    )) as { turnId: string | null; cursor: string };
    return { turnId: accepted.turnId!, cursor: accepted.cursor };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
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
      agentId: caller.agentId,
      ownerUserId: caller.access.owner,
    },
    caller.access
  );
}

async function sendMessage(
  caller: Caller,
  params: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ task: Task }> {
  const send = parseSendParams(params);
  const idempotencyKey = `a2a:${send.messageId}`;
  const value = "content" in send.input ? send.input.content : send.input.data;
  let contextId: string;
  let sessionId: string;
  let accepted: { turnId: string; cursor: string };
  if (send.taskId !== undefined) {
    // A reply on an existing task: only a question it is waiting on can take it.
    const ids = parseTaskId(send.taskId) ?? taskNotFound(send.taskId);
    if (send.contextId !== undefined && send.contextId !== ids.contextId)
      a2aFail(
        "invalidParams",
        "message.contextId does not match the task's context",
        {},
        "message.contextId"
      );
    contextId = ids.contextId;
    sessionId = contextSessionId(caller.access.owner, caller.agentId, contextId);
    const session =
      (await contextSession(caller, sessionId)) ?? taskNotFound(send.taskId);
    const prior = await caller.ctx.store.tx((t) =>
      t.get<{ command: SessionCommand }>("commands", commandKey(sessionId, idempotencyKey))
    );
    // A retried reply replays through `command`, which compares it with the first one.
    const interactionId =
      prior?.command.type === "respond"
        ? prior.command.interactionId
        : prior
        ? a2aFail(
            "invalidParams",
            "message.messageId was already used for a different message",
            {},
            "message.messageId"
          )
        : await replyTarget(caller, session, sessionId, ids.turnId, send.taskId);
    accepted = await run(
      caller,
      sessionId,
      {
        type: "respond",
        requestId: randomUUID(),
        idempotencyKey,
        interactionId,
        value,
      },
      async () =>
        new A2aError("unsupportedOperation", "The task is no longer waiting for input", {
          taskId: send.taskId!,
        })
    );
    accepted = { ...accepted, turnId: ids.turnId };
  } else {
    contextId =
      send.contextId ?? newContextId(caller.access.owner, caller.agentId, send.messageId);
    sessionId = contextSessionId(caller.access.owner, caller.agentId, contextId);
    await openContext(caller, sessionId);
    const context = contextId;
    accepted = await run(
      caller,
      sessionId,
      {
        type: "message",
        requestId: randomUUID(),
        idempotencyKey,
        ...send.input,
      } as SessionCommand,
      async () => {
        const active = (await contextSession(caller, sessionId))?.activeTurnId;
        const taskId = active ? taskIdOf(context, active) : undefined;
        return taskId
          ? new A2aError(
              "unsupportedOperation",
              `The context has a task in progress (${taskId}); reply to it or cancel it`,
              { taskId }
            )
          : new A2aError(
              "unsupportedOperation",
              "The context has unresolved work; start a new context"
            );
      }
    );
  }
  if (!send.returnImmediately)
    await settled(caller.ctx, sessionId, accepted.turnId, accepted.cursor, signal);
  const { task } = await ownedTask(
    caller,
    taskIdOf(contextId, accepted.turnId),
    send.historyLength
  );
  return { task };
}

/** The interaction a reply answers: the task must be active and paused on a question. */
async function replyTarget(
  caller: Caller,
  session: Session,
  sessionId: string,
  turnId: string,
  taskId: string
): Promise<string> {
  if (session.activeTurnId !== turnId) {
    // Ended, or never this caller's: a terminal task takes no more messages.
    const task = buildTask({
      contextId: parseTaskId(taskId)!.contextId,
      turnId,
      session,
      events: await turnEvents(caller.ctx, sessionId, turnId),
    });
    if (!task) return taskNotFound(taskId);
    return a2aFail(
      "unsupportedOperation",
      "The task is in a terminal state and accepts no more messages; send a new message without taskId",
      { taskId }
    );
  }
  const pending = session.status === "paused" ? pendingInteraction(session) : undefined;
  if (!pending)
    return a2aFail(
      "unsupportedOperation",
      "The task is working and not waiting for input; wait for it or cancel it",
      { taskId }
    );
  if (pending.kind === "approval")
    return a2aFail(
      "unsupportedOperation",
      "The task waits for an approval, which A2A callers cannot give yet; cancel the task instead",
      { taskId }
    );
  return pending.id;
}

async function cancelTask(caller: Caller, taskId: string): Promise<Task> {
  const owned = await ownedTask(caller, taskId);
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

/**
 * Waits until the turn ends, pauses or has an uncertain effect, the caller hangs up, or
 * `A2A_BLOCKING_WAIT_MS` passes. Follows the session's shared stream from the command's
 * cursor, so the events the task is built from are there when it returns. A feed that ends
 * (reset, deleted, closing) ends the wait: the task says what the session says then.
 */
async function settled(
  ctx: TenantContext,
  sessionId: string,
  turnId: string,
  cursor: string,
  signal: AbortSignal
): Promise<void> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), A2A_BLOCKING_WAIT_MS);
  timer.unref();
  const hangup = () => stop.abort();
  signal.addEventListener("abort", hangup, { once: true });
  if (signal.aborted) stop.abort();
  try {
    for await (const event of observeSession(ctx, sessionId, cursor, {
      signal: stop.signal,
    }))
      if (event.turnId === turnId && SETTLED_EVENTS.has(event.type)) return;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", hangup);
  }
}
