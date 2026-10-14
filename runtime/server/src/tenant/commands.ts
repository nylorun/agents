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
 */
import { randomUUID } from "node:crypto";
import type { EventPrincipal, EventWriter, LiveEvent, SessionCommand } from "@nylorun/core/contracts";
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
import { fail } from "./http.js";
import { settleToolRow, type ToolRow } from "../harness-api/tool-journal.js";
import { accessOf } from "./auth.js";
import { checkEnvironmentTurn } from "./environments.js";
import { turnManifestOf, variantStore } from "./session.js";
import { slimModelEffects } from "./slim.js";
import { resolveMessageParts } from "../artifacts/parts.js";
import { currentModelInputs } from "../model/catalog.js";
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
  options: { trace?: TraceContext } = {}
): Promise<unknown> {
  const { store } = ctx;
  const cascadeCancelIds: string[] = [];
  // What the Tenant's model reads, for a message that names a file (protocol 12): read before
  // the session's transaction. Undefined without a model in the vault: nothing is refused.
  const inputs =
    input.type === "message" && "parts" in input && input.parts.some((part) => part.type === "file")
      ? await currentModelInputs(ctx)
      : undefined;
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
    if (command.type === "cancel") {
      cancelledTurnId = s.activeTurnId;
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
      // A session opened before protocol 11 (migration 0020) keeps its history but takes no turn.
      if (s.closedReason !== undefined)
        fail(
          409,
          "This session was opened before protocol 11: open a new session that names an Environment.",
          { code: "session_closed" }
        );
      if (command.type === "message") {
        if (!["idle", "completed", "failed", "cancelled"].includes(s.status))
          fail(409, "Session has active or unresolved work");
        // Every turn start on a sandbox: it exists, the token's grants reach it, and no other
        // session's turn holds it.
        await checkEnvironmentTurn(t, s, scope, ctx);
        s.turnStartState = s.state;
        // A new turn folds from the latest snapshot: a cancel or failure only reverts this turn.
        if (s.history?.snapshot !== undefined) s.history = { ...s.history, from: s.history.snapshot };
        s.activeTurnId = randomUUID();
        startTurn(s);
        if (options.trace) s.turnTrace = options.trace;
        else delete s.turnTrace;
        // File parts name artifacts the caller may read; each is pinned to a version now. An
        // agent's model must read each one (a workflow passes them on as data).
        const parts =
          "parts" in command
            ? await resolveMessageParts(
                t,
                command.parts,
                id,
                accessOf(scope),
                isWorkflowManifest(s.manifest) ? undefined : inputs
              )
            : undefined;
        if (parts && parts.refused.length > 0)
          fail(
            422,
            `The model does not read ${parts.refused
              .map((part) => `${part.name} (${part.reason})`)
              .join(", ")}.`,
            { code: "attachment_unsupported", details: { parts: parts.refused } }
          );
        // The files the session's messages named: `read_artifact` reads them again (protocol 12).
        if (parts) {
          const named = parts.pinned.flatMap((part) => (part.type === "file" ? [part.artifactId] : []));
          if (named.length > 0) s.fileArtifacts = [...new Set([...(s.fileArtifacts ?? []), ...named])];
        }
        const data = "data" in command ? (command.data as JsonValue) : undefined;
        if (isWorkflowManifest(s.manifest)) {
          const input: JsonValue =
            "content" in command
              ? command.content
              : parts
              ? ({ parts: parts.pinned } as unknown as JsonValue)
              : data!;
          s.checkpoint = createFlowCheckpoint({
            manifest: s.manifest,
            sessionId: id,
            turnId: s.activeTurnId,
            input,
          });
        } else {
          // Optional message.manifest: validate as variant, pin by hash, apply this turn only.
          const resolved = resolveMessageManifest({
            pinned: s.manifest,
            pinnedHash: s.manifestHash,
            messageManifest: command.manifest,
            store: variantStore(s),
          });
          if (!resolved.ok) {
            fail(400, resolved.message);
          } else {
            s.checkpoint = createDurableCheckpoint({
              manifest: resolved.manifest,
              sessionId: id,
              turnId: s.activeTurnId,
              input:
                "content" in command
                  ? command.content
                  : parts
                  ? { content: parts.engine }
                  : typeof data === "string"
                  ? data
                  : JSON.stringify(data),
              state: s.state,
              info: s.info,
            });
          }
        }
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
      // A paused turn goes on: its wait for a person is not its running time (R7.1).
      resumeTurn(s);
      s.status = "runnable";
      s.waits = undefined;
      // A flow answers each interaction in the same segment, as a held tool call's approval is
      // answered (R5 step 2): the interaction names the cause.
      const cause =
        command.type !== "message" && (isWorkflowManifest(s.manifest) || held !== undefined)
          ? command.interactionId
          : s.checkpoint!.segment;
      const commandWake = {
        reason: command.type,
        dedupeKey: `${command.type}:${s.activeTurnId}:${cause}`,
      };
      await t.wake(id, commandWake);
      event = await t.event(
        id,
        s.activeTurnId,
        `command.${command.type}`,
        command.type === "message" && options.trace ? { ...command, trace: options.trace } : command,
        commandWriter(scope)
      );
    }
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
      status: "accepted",
      turnId: s.activeTurnId,
      cursor: event.cursor,
      requestId: command.requestId,
    };
    await t.put("commands", key, { command, response });
    return response;
  });
  if (input.type === "cancel") ctx.abortLocal(id);
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
