/**
 * The session command service: `message`, `approve`/`respond` and `cancel`,
 * with per-session idempotency keys. A command locks its session and commits its state
 * change, events and wakes in one transaction (the store publishes the events and delivers the
 * wakes from its outbox after commit, `Tx.wake`), then aborts a cancelled advance and cascades
 * workflow cancels to the linked agent sessions, one transaction each.
 *
 * Wakes (`t.wake`, architecture §12.3) carry the command type as the reason and a dedupe
 * key naming the cause: `<type>:<turnId>:<segment>` for `message`, `approve` and `respond`
 * (every accepted one writes a new checkpoint segment), except that a workflow's `approve` and
 * `respond` name `<type>:<turnId>:<interactionId>`: a flow resumes in the same segment.
 *
 * Cancel commits `cancelled` first, with a `session.cancel` signal on the control bus in the
 * same transaction; the engine host sees it before its next effect and before settlement on
 * any Worker. It then aborts an advance running on this process (`ctx.abortLocal`); every
 * other process aborts its own on the signal (`control.ts`).
 *
 * A message to a session whose turn runs or waits (protocol 17, D76) is queued
 * (`session_queue`, `message.queued`) unless it asks `delivery: "reject"`, which is
 * `409 session_busy`. A turn that ends takes every queued message in the same transaction
 * (`startQueuedTurn`): client messages and queued ones start a turn through one door,
 * `beginMessageTurn`, which writes each one's `command.message`.
 */
import { randomUUID } from "node:crypto";
import type {
  EventPrincipal,
  EventWriter,
  LiveEvent,
  MessageDelivery,
  MessageEventBody,
  SessionCommand,
} from "@nylorun/core/contracts";
import {
  createDurableCheckpoint,
  createFlowCheckpoint,
  resumeFlowCheckpoint,
  type FlowCheckpoint,
} from "@nylorun/harness/run";
import type { JsonValue } from "@nylorun/core/define";
import {
  commandKey,
  cancelQueuedEffects,
  flowInteractionOf,
  foreignInteractionConflict,
  isWorkflowManifest,
  planCancelCascade,
  wakeLinkedWorkflow,
} from "../core/flow-host.js";
import { resolveMessageManifest } from "../core/turn-manifest.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import {
  lockedSession,
  type AuthScope,
  type Session,
  type TenantContext,
} from "./context.js";
import { fail, HttpError } from "./http.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { settleToolRow, type ToolRow } from "../harness-api/tool-journal.js";
import { accessOf } from "./auth.js";
import { checkAgentTurn } from "./agents.js";
import { turnManifestOf, variantStore } from "./session.js";
import { slimModelEffects } from "./slim.js";
import { resolveMessageParts } from "../artifacts/parts.js";
import { endTurn, resumeTurn, startTurn } from "./turn-timing.js";
import type { TraceContext } from "../traces/ids.js";

/** A command's identity for idempotency: everything but the request id. */
const semantic = (value: any): string => {
  const { requestId: _, ...body } = value;
  return canonical(body);
};

export async function command(
  ctx: TenantContext,
  id: string,
  input: SessionCommand,
  scope: AuthScope,
  /**
   * The W3C trace context the request carried (R7.4): a `message` records it on its
   * `command.message`, and the turn joins the caller's trace. Not part of the command's identity.
   */
  options: {
    trace?: TraceContext;
    /**
     * What a message to a busy session does when it says nothing (`delivery`): the route's
     * answer to the caller's protocol (`queue` from 17). Core's own messages and the AG-UI and
     * A2A adapters, which stream the run they start, take `reject`.
     */
    delivery?: MessageDelivery;
  } = {}
): Promise<unknown> {
  const { store } = ctx;
  const cascadeCancelIds: string[] = [];
  let cancelledTurn: string | null = null;
  const response = await store.tx(async (t) => {
    const s = await lockedSession(t, id, accessOf(scope));
    const command = input;
    // A person's token may not replace the instructions of a turn.
    if (
      scope.kind === "token" &&
      command.type === "message" &&
      command.manifest !== undefined
    )
      fail(403, "A token caller cannot send message.manifest", {
        code: "scope_required",
      });
    const key = commandKey(id, command.idempotencyKey);
    const existing = await t.get("commands", key);
    if (existing) {
      if (semantic(existing.command) !== semantic(command))
        fail(409, "Idempotency key already binds another command");
      return existing.response;
    }
    let event: LiveEvent;
    // A tool call the Tool Gate held, which this `approve` answers (R5 step 2).
    let held: ToolRow | undefined;
    // The turn a `cancel` ended, if one was active.
    let cancelledTurnId: string | null = null;
    /** A message's answer: accepted with its turn, or queued (protocol 17). */
    let answer: Record<string, unknown> | undefined;
    if (command.type === "cancel") {
      cancelledTurnId = s.activeTurnId;
      cancelledTurn = cancelledTurnId;
      const workflowCancel = isWorkflowManifest(s.manifest);
      // Linked sessions this one started: a workflow's agents, or flow agents an agent
      // uses as tools.
      const cascade = await planCancelCascade({
        t,
        workflowSessionId: id,
        turnId: cancelledTurnId,
      });
      s.status = "cancelled";
      if (workflowCancel)
        await cancelQueuedEffects({
          t,
          workflowSessionId: id,
          turnId: cancelledTurnId,
        });
      if (cancelledTurnId !== null)
        for (const effect of await t.effectsForTurn<any>(
          id,
          cancelledTurnId,
          ["invoking", "held"]
        )) {
          // A tool call ends `cancelled` with its `tool.completed` (R5.1); it may have run.
          if (effect.request.kind === "tool") {
            await settleToolRow(t, s, effect, {
              kind: "failed",
              code: "tool.cancelled",
              message: "The turn was cancelled while this call ran; it may have run.",
            }, { cancelled: true });
            continue;
          }
          effect.status = "uncertain";
          effect.error =
            "Turn cancelled before model outcome was durably recorded";
          await t.put("effects", effect.request.effectId, effect);
        }
      // The cancelled turn's span (R7.1): its duration, agent and totals.
      const ended = cancelledTurnId !== null ? await endTurn(t, s, cancelledTurnId) : {};
      event = await t.event(
        id,
        cancelledTurnId,
        "turn.cancelled",
        { reason: command.reason, ...ended },
        commandWriter(scope)
      );
      await slimModelEffects(t, id, cancelledTurnId);
      // The process running the advance aborts it on this signal (control.ts), sent at commit.
      await t.signal({
        type: "session.cancel",
        sessionId: id,
        ...(cancelledTurnId !== null ? { turnId: cancelledTurnId } : {}),
      });
      s.activeTurnId = null;
      if (cancelledTurnId !== null) s.lastTurnId = cancelledTurnId;
      // The next turn starts from the state preceding the cancelled turn, never its paused plan.
      if (cancelledTurnId !== null) s.state = s.turnStartState;
      s.checkpoint = undefined;
      s.waits = undefined;
      s.error = undefined;
      // Cascade: cancel linked agent sessions deepest-first (after fencing this session), each
      // in its own transaction after this one commits (child sessions are never locked here).
      for (const agentId of cascade.agentSessionIds) {
        const agent = await t.get<Session>("sessions", agentId);
        if (
          !agent ||
          !agent.activeTurnId ||
          ["idle", "completed", "failed", "cancelled"].includes(agent.status)
        )
          continue;
        cascadeCancelIds.push(agentId);
      }
    } else {
      // A session opened before protocol 11 (migration 0020), 13 (migration 0024), 15
      // (migrations 0029, 0030) or 16 (migration 0032) keeps its history but takes no turn.
      if (s.closedReason !== undefined)
        fail(
          409,
          s.closedReason === "protocol_16"
            ? "This session was opened before protocol 16, from an agent definition: save the agent as an agent manifest (nylorun migrate v8, then nylorun apply), make an Agent from it and open a new session on it."
            : s.closedReason === "protocol_11"
            ? "This session was opened before protocol 11: open a new session on an Agent."
            : s.closedReason === "protocol_15"
              ? "This session was opened before protocol 15, and its pinned manifest holds a runtime block: our harness now writes the model's instructions and defines its tools itself. Open a new session."
              : "This session was opened before protocol 13, on a manifest the Runtime no longer runs: register the agent again (manifest 7) and open a new session.",
          { code: "session_closed" }
        );
      if (command.type === "message") {
        const delivery = command.delivery ?? options.delivery ?? "reject";
        const waiting = await t.countQueuedMessages(id);
        if (!takesMessages(s) && delivery === "reject")
          fail(409, "Session has active or unresolved work", { code: "session_busy" });
        // Every turn start on a sandbox: it exists, the token's grants reach it, and no other
        // session's turn holds it. A queued message is checked when it is queued, too.
        await checkAgentTurn(t, s, scope, ctx);
        answer = await acceptMessage(ctx, t, s, id, await turnMessage(t, s, id, command, scope, options.trace), waiting);
      } else if (
        command.type === "approve" &&
        (held = await heldCall(t, s, command.interactionId)) !== undefined
      ) {
        // A tool call the Tool Gate held for approval (R5 step 2). Approved: the replay sends it
        // again and the gate runs it. Denied: it fails to the model as `tool.denied`, unsent.
        if (s.status !== "paused") fail(409, "Session is not awaiting a response");
        if (command.approved) {
          held.status = "invoking";
          const by = principalOf(scope);
          held.approval = { approved: true, at: new Date().toISOString(), ...(by ? { by } : {}) };
          await t.put("effects", held.request.effectId, held);
        } else
          await settleToolRow(t, s, held, {
            kind: "failed",
            code: "tool.denied",
            message: "A person denied this call; it was not sent.",
          });
      } else if (isWorkflowManifest(s.manifest)) {
        // Approvals owned by linked agent sessions must be answered there (WF-R52).
        const conflict = await foreignInteractionConflict({
          t,
          workflowSessionId: id,
          interactionId: command.interactionId,
        });
        if (conflict) fail(409, conflict.message);
        if (s.status !== "paused" || !s.checkpoint || !s.activeTurnId)
          fail(409, "Session is not awaiting a response");
        // The flow's own interactions: a tool node that asked (`ctx.approve`, `ctx.ask`).
        const asked = flowInteractionOf(s.waits, id, command.interactionId);
        if (!asked) fail(409, "Unknown interaction");
        else if ((command.type === "approve") !== (asked.kind === "approval"))
          fail(409, "Interaction response kind does not match the saved request");
        // Same segment: the flow replays its journal and runs the tool again with the answer.
        s.checkpoint = resumeFlowCheckpoint(
          s.checkpoint as FlowCheckpoint,
          command.interactionId,
          command.type === "approve"
            ? { kind: "approval", approved: command.approved }
            : { kind: "response", value: command.value as JsonValue }
        );
      } else {
        if (s.status !== "paused" || !s.state || !s.activeTurnId)
          fail(409, "Session is not awaiting a response");
        const pending = s.state.plan?.calls ?? [];
        if (
          !pending.some(
            (c: any) =>
              c.status === "interaction" &&
              c.interaction?.id === command.interactionId &&
              (command.type === "approve") ===
                (c.interaction?.kind === "approval")
          )
        )
          fail(409, "Unknown interaction");
        const input =
          command.type === "approve"
            ? {
                kind: "approve" as const,
                interactionId: command.interactionId,
                approved: command.approved,
              }
            : {
                kind: "respond" as const,
                interactionId: command.interactionId,
                value: command.value,
              };
        s.checkpoint = createDurableCheckpoint({
          manifest: turnManifestOf(s),
          sessionId: id,
          turnId: s.activeTurnId!,
          input: input as any,
          state: s.state,
          info: s.info,
          segment: (s.checkpoint?.segment ?? 0) + 1,
        });
      }
    }
    if (command.type !== "cancel" && command.type !== "message") {
      // A paused turn goes on: its wait for a person is not its running time (R7.1).
      resumeTurn(s);
      s.status = "runnable";
      s.waits = undefined;
      // A flow answers each interaction in the same segment, as a held tool call's approval is
      // answered (R5 step 2): the interaction names the cause.
      const cause =
        isWorkflowManifest(s.manifest) || held !== undefined
          ? command.interactionId
          : s.checkpoint!.segment;
      const commandWake = {
        reason: command.type,
        dedupeKey: `${command.type}:${s.activeTurnId}:${cause}`,
      };
      await t.wake(id, commandWake);
      event = await t.event(id, s.activeTurnId, `command.${command.type}`, command, commandWriter(scope));
    }
    // A cancel ends the turn, not the queue: the messages waiting start the next one.
    if (command.type === "cancel") await startQueuedTurn(ctx, t, s, id);
    await t.put("sessions", id, s);
    // Direct cancel of a linked agent fails that node with agent.cancelled (WF-R54). The agent
    // session is locked above, before wakeLinkedWorkflow locks its workflow.
    if (command.type === "cancel")
      await wakeLinkedWorkflow({
        t,
        agentSessionId: id,
        turnId: cancelledTurnId,
        cancelled: true,
        error: "Agent turn was cancelled",
      });
    const response = {
      ...(answer ?? {
        status: "accepted",
        turnId: command.type === "cancel" ? null : s.activeTurnId,
        cursor: event!.cursor,
      }),
      requestId: command.requestId,
    };
    await t.put("commands", key, { command, response });
    return response;
  });
  if (input.type === "cancel") ctx.abortLocal(id, cancelledTurn ?? undefined);
  // Cascade cancel linked agents deepest-first under existing fencing (WF-R53).
  for (const agentId of cascadeCancelIds) {
    try {
      await command(
        ctx,
        agentId,
        {
          type: "cancel",
          requestId: `flow-cascade-${id}-${agentId}`,
          idempotencyKey: `flow-cascade-cancel:${id}:${agentId}`,
          reason: "workflow cancelled",
        },
        scope
      );
    } catch {
      /* agent may already be terminal */
    }
  }
  return response;
}

/** Statuses in which a session takes a message as a new turn; in the others a turn runs or waits. */
const TAKES_MESSAGES: readonly string[] = ["idle", "completed", "failed", "cancelled"];

export const takesMessages = (s: Session): boolean => TAKES_MESSAGES.includes(s.status);

/** A message ready to start a turn: as sent, its engine input and who sent it. */
export interface TurnMessage {
  command: MessageEventBody;
  /** An agent's message input, or a workflow's input value. */
  input: unknown;
  /** The artifacts its file parts named. */
  fileArtifacts: string[];
  writer: EventWriter;
  /** Set for a message that waited in the session's queue. */
  queuedMessageId?: string;
  trace?: TraceContext;
  /** What sent it when not a client (track T4): a trigger's run, or the session's own wake. */
  cause?: MessageCause;
}

/** What sent a message when not a client (`command.message`'s `cause`). */
export interface MessageCause {
  kind: "trigger" | "self";
  triggerId: string;
  runId: string;
}

/** How a message was taken: it started a turn, or waits in the session's queue. */
export type MessageAnswer =
  | { status: "accepted"; turnId: string; cursor: string }
  | { status: "queued"; queuedMessageId: string; position: number; cursor: string };

/**
 * Takes a resolved message on session `s` (locked) in transaction `t`: it starts a turn when the
 * session takes messages and none wait, else it waits in the queue behind them (protocol 17), and
 * an idle session whose queue was left waiting (its Agent was unavailable when the last turn
 * ended) starts a turn with all of them, this one last. Past `sessionQueuedMessages` it is
 * `429 queue_full`. `waiting` is the queue's length, read under the session's lock.
 */
export async function acceptMessage(
  ctx: TenantContext,
  t: Tx,
  s: Session,
  id: string,
  message: TurnMessage,
  waiting?: number
): Promise<MessageAnswer> {
  const queued = waiting ?? (await t.countQueuedMessages(id));
  const takes = takesMessages(s);
  if (takes && queued === 0) {
    const event = await beginMessageTurn(t, s, id, [message]);
    return { status: "accepted", turnId: s.activeTurnId!, cursor: event.cursor };
  }
  // The turn runs or waits, or earlier messages still wait: this one waits behind them.
  const { sessionQueuedMessages } = await readRuntimeLimits(t);
  if (queued >= sessionQueuedMessages)
    fail(
      429,
      `Session ${id} already holds ${queued} queued messages, the Runtime limit sessionQueuedMessages (PUT /v1/tenant/limits); they start a turn when the running one ends.`,
      { code: "queue_full" }
    );
  const queuedMessageId = randomUUID();
  await t.enqueueMessage({
    id: queuedMessageId,
    sessionId: id,
    command: message.command,
    input: message.input,
    fileArtifacts: message.fileArtifacts,
    writer: message.writer,
    trace: message.trace ?? null,
    cause: message.cause ?? null,
    createdAt: new Date().toISOString(),
  });
  const position = queued + 1;
  const event = await t.event(
    id,
    s.activeTurnId,
    "message.queued",
    { queuedMessageId, position, requestId: message.command.requestId },
    message.writer
  );
  const started = takes ? await startQueuedTurn(ctx, t, s, id) : undefined;
  if (started?.taken.includes(queuedMessageId))
    return { status: "accepted", turnId: started.turnId, cursor: started.cursor };
  return { status: "queued", queuedMessageId, position, cursor: event.cursor };
}

/**
 * Resolves a message for a turn, now or when it leaves the queue: file parts name artifacts the
 * caller may read, each pinned to a version (any file goes since protocol 15: the harness decides
 * how the model sees it, and a workflow passes it on as data), and a turn manifest must be a
 * variant of the pinned agent.
 */
async function turnMessage(
  t: Tx,
  s: Session,
  id: string,
  command: MessageEventBody,
  scope: AuthScope,
  trace: TraceContext | undefined
): Promise<TurnMessage> {
  const parts =
    "parts" in command ? await resolveMessageParts(t, command.parts, id, accessOf(scope)) : undefined;
  const fileArtifacts = (parts?.pinned ?? []).flatMap((part) => (part.type === "file" ? [part.artifactId] : []));
  const data = "data" in command ? (command.data as JsonValue) : undefined;
  let input: unknown;
  if (isWorkflowManifest(s.manifest))
    input =
      "content" in command
        ? command.content
        : parts
        ? ({ parts: parts.pinned } as unknown as JsonValue)
        : data!;
  else {
    const resolved = resolveMessageManifest({
      pinned: s.manifest,
      pinnedHash: s.manifestHash,
      messageManifest: command.manifest,
      store: variantStore(s),
    });
    if (!resolved.ok) fail(400, resolved.message);
    input =
      "content" in command
        ? command.content
        : parts
        ? { content: parts.engine }
        : typeof data === "string"
        ? data
        : JSON.stringify(data);
  }
  return { command, input, fileArtifacts, writer: commandWriter(scope), ...(trace ? { trace } : {}) };
}

/**
 * Starts a turn on session `s` (locked, taking messages) with `messages`, in order: the one door
 * for a client's message and queued ones (protocol 17). Our engine reads more than one as
 * `{kind: "messages", messages}`, each its own user message; a workflow takes one. The checkpoint
 * is made before the session changes, so a manifest that no longer resolves changes nothing.
 * Writes each message's `command.message` and returns the last.
 */
async function beginMessageTurn(
  t: Tx,
  s: Session,
  id: string,
  messages: readonly TurnMessage[]
): Promise<LiveEvent> {
  const turnId = randomUUID();
  const first = messages[0]!;
  let checkpoint: Session["checkpoint"];
  if (isWorkflowManifest(s.manifest))
    checkpoint = createFlowCheckpoint({
      manifest: s.manifest,
      sessionId: id,
      turnId,
      input: first.input as JsonValue,
    });
  else {
    const resolved = resolveMessageManifest({
      pinned: s.manifest,
      pinnedHash: s.manifestHash,
      messageManifest: first.command.manifest,
      store: variantStore(s),
    });
    if (!resolved.ok) return fail(400, resolved.message);
    checkpoint = createDurableCheckpoint({
      manifest: resolved.manifest,
      sessionId: id,
      turnId,
      input: (messages.length === 1
        ? first.input
        : { kind: "messages", messages: messages.map((message) => message.input) }) as any,
      state: s.state,
      info: s.info,
    });
  }
  s.turnStartState = s.state;
  // A new turn folds from the latest snapshot: a cancel or failure only reverts this turn.
  if (s.history?.snapshot !== undefined) s.history = { ...s.history, from: s.history.snapshot };
  s.activeTurnId = turnId;
  startTurn(s);
  if (first.trace) s.turnTrace = first.trace;
  else delete s.turnTrace;
  // A trigger's run or a booked wake among the messages started it (track T4).
  const cause = messages.find((message) => message.cause)?.cause;
  if (cause) s.turnCause = { kind: cause.kind, triggerId: cause.triggerId, runId: cause.runId };
  else delete s.turnCause;
  // The files the session's messages named: `read_artifact` reads them again (protocol 12).
  const named = messages.flatMap((message) => message.fileArtifacts);
  if (named.length > 0) s.fileArtifacts = [...new Set([...(s.fileArtifacts ?? []), ...named])];
  s.checkpoint = checkpoint;
  s.status = "runnable";
  s.waits = undefined;
  await t.wake(id, { reason: "message", dedupeKey: `message:${turnId}:${checkpoint!.segment}` });
  let event: LiveEvent | undefined;
  for (const message of messages)
    event = await t.event(
      id,
      turnId,
      "command.message",
      {
        ...message.command,
        ...(message.queuedMessageId === undefined ? {} : { queuedMessageId: message.queuedMessageId }),
        ...(message.trace ? { trace: message.trace } : {}),
        ...(message.cause ? { cause: message.cause } : {}),
      },
      message.writer
    );
  return event!;
}

/** Who checks a queued message's turn start: core, since the sender's grants were checked when it was queued. */
export const QUEUE_SCOPE: AuthScope = { kind: "application", principalId: "queue" };

/**
 * Starts the next turn of session `s` (locked) from its queue, when it takes messages and messages
 * wait (protocol 17, D76): in the transaction that ended the last turn, or a cancel's. Our engine
 * takes every queued message that carries the same turn manifest as the first, a workflow one.
 * Writes `queue.taken`. Returns nothing when nothing started: an empty queue, or an Agent that
 * cannot take a turn now, whose messages wait for the next message or turn end.
 */
export async function startQueuedTurn(
  ctx: TenantContext,
  t: Tx,
  s: Session,
  id: string
): Promise<{ turnId: string; taken: string[]; cursor: string } | undefined> {
  if (s.closedReason !== undefined || !takesMessages(s) || s.activeTurnId !== null) return undefined;
  const queued = await t.queuedMessages(id);
  if (queued.length === 0) return undefined;
  const manifestOf = (row: (typeof queued)[number]) => canonical((row.command as MessageEventBody).manifest ?? null);
  const batch = isWorkflowManifest(s.manifest) ? [queued[0]!] : [];
  if (batch.length === 0)
    for (const row of queued) {
      if (manifestOf(row) !== manifestOf(queued[0]!)) break;
      batch.push(row);
    }
  try {
    await checkAgentTurn(t, s, QUEUE_SCOPE, ctx);
    await beginMessageTurn(
      t,
      s,
      id,
      batch.map((row) => ({
        command: row.command as MessageEventBody,
        input: row.input,
        fileArtifacts: row.fileArtifacts as string[],
        writer: row.writer as EventWriter,
        queuedMessageId: row.id,
        ...(row.trace ? { trace: row.trace as TraceContext } : {}),
        ...(row.cause ? { cause: row.cause as MessageCause } : {}),
      }))
    );
  } catch (error) {
    if (error instanceof HttpError) return undefined;
    throw error;
  }
  const taken = batch.map((row) => row.id);
  await t.deleteQueuedMessages(taken);
  const event = await t.event(id, s.activeTurnId, "queue.taken", {
    turnId: s.activeTurnId!,
    queuedMessageIds: taken,
  });
  return { turnId: s.activeTurnId!, taken, cursor: event.cursor };
}

/** Core's own commands (R4.9): the flow host's, and a drain's cancels. */
const CORE_PRINCIPALS: Readonly<Record<string, "flow-host" | "core">> = { "flow-host": "flow-host", drain: "core" };

/**
 * Who sent a command (R4.9), from its credential and never its body: a client over the Runtime
 * API (an application, or a person through it or a token), or core itself.
 */
export function commandWriter(scope: AuthScope): EventWriter {
  if (scope.kind === "application" && CORE_PRINCIPALS[scope.principalId] !== undefined)
    return {
      source: { kind: "core", id: "runtime" },
      principal: { kind: CORE_PRINCIPALS[scope.principalId]!, id: scope.principalId },
    };
  const principal: EventPrincipal =
    scope.kind === "subject" || scope.kind === "token"
      ? { kind: "subject", id: scope.subject }
      : { kind: "application", id: scope.kind === "anonymous" ? "anonymous" : scope.principalId };
  return { source: { kind: "client", id: principal.id }, principal };
}

/** The held tool call of the session's active turn that `interactionId` names (R5 step 2). */
async function heldCall(t: Tx, s: Session, interactionId: string): Promise<ToolRow | undefined> {
  const row = await t.get<ToolRow>("effects", interactionId);
  if (row?.status !== "held") return undefined;
  if (row.request.sessionId !== s.id || row.request.turnId !== s.activeTurnId) return undefined;
  return row;
}

/** Who answered: the principal (its subject, when it acts for one), or the token's subject. */
function principalOf(scope: AuthScope): string | undefined {
  if (scope.kind === "token") return `${scope.issuer}:${scope.subject}`;
  if (scope.kind === "subject") return `${scope.principalId}:${scope.subject}`;
  return "principalId" in scope ? scope.principalId : undefined;
}
