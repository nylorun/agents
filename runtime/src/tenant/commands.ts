/**
 * The session command service: `message`, `approve`/`respond` and `cancel`,
 * with per-session idempotency keys. A command locks its session and commits its state
 * change, events and wakes in one transaction (the store publishes the events and runs the
 * `afterCommit` wakes), then aborts a cancelled advance and cascades workflow cancels to the
 * linked agent sessions, one transaction each.
 *
 * Wakes (`ctx.wake`, architecture §12.3) carry the command type as the reason and a dedupe
 * key naming the cause: `<type>:<turnId>:<segment>` for `message`, `approve` and `respond`
 * (every accepted one writes a new checkpoint segment). An Action's outcome
 * (`recordActionOutcome`, from the deliverer) wakes with
 * `action_result:<turnId>:<actionId>:<generation>`.
 *
 * Cancel commits `cancelled` first; the engine host sees it before its next effect and before
 * settlement on any Worker. It then aborts an advance running on this process
 * (`ctx.abortLocal`); reaching an advance on another process is the control stream's job.
 */
import { randomUUID } from "node:crypto";
import type {
  Action,
  ActionOutcome,
  LiveEvent,
  SessionCommand,
} from "@nylorun/core/contracts";
import {
  createDurableCheckpoint,
  createFlowCheckpoint,
} from "@nylorun/harness/run";
import {
  schemaFromJSON,
  type JsonObject,
  type JsonValue,
} from "@nylorun/core/define";
import {
  commandKey,
  fenceWorkflowActions,
  foreignInteractionConflict,
  isWorkflowManifest,
  planCancelCascade,
  wakeForQueuedEffects,
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
import { accessOf } from "./auth.js";
import { chargeTurn } from "./subject-limits.js";
import {
  actionTarget,
  rebaseSessionState,
  turnManifestOf,
  variantStore,
} from "./session.js";
import { signalSessionCancel } from "./streams.js";
import { toolIds } from "./transcript.js";

/** `outcome`, or a failed one when a tool's output does not match its stored output schema. */
export function acceptedOutcome(action: Action, outcome: ActionOutcome): ActionOutcome {
  if (action.kind !== "tool" || !action.outputSchema) return outcome;
  const value = outcome.value;
  // Only a result carries output: failures, denials, interactions and deferrals pass as sent.
  if (!isResultToolValue(value)) return outcome;
  // Endpoints wrap successful tool output as `{ kind: "completed", output }`.
  // Validate the tool payload, not the outcome envelope.
  const candidate = completedToolOutput(value);
  let matches = false;
  try {
    matches = schemaFromJSON(action.outputSchema as JsonObject).validate(
      candidate
    ).ok;
  } catch {
    matches = false;
  }
  if (matches) return outcome;
  return {
    ...outcome,
    value: {
      kind: "failed",
      code: "tool.invalid-output",
      message: "Tool result does not match the output schema stored on the action",
    },
  };
}

function completedToolOutput(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "completed" &&
    "output" in (value as object)
  ) {
    return (value as { output: unknown }).output;
  }
  return value;
}

const NON_RESULT_KINDS = new Set([
  "failed",
  "denied",
  "interaction-required",
  "deferred",
]);

function isResultToolValue(value: unknown): boolean {
  return !(
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    NON_RESULT_KINDS.has((value as { kind?: unknown }).kind as string)
  );
}

/** A command's identity for idempotency: everything but the request id. */
const semantic = (value: any): string => {
  const { requestId: _, ...body } = value;
  return canonical(body);
};

export async function command(
  ctx: TenantContext,
  id: string,
  input: SessionCommand,
  scope: AuthScope
): Promise<unknown> {
  const { store } = ctx;
  const cascadeCancelIds: string[] = [];
  const response = await store.tx(async (t) => {
    const s = await lockedSession(t, id, accessOf(scope));
    const command = input;
    // A person's token may not replace the instructions of a turn.
    if (
      scope.kind === "token" &&
      command.type === "message" &&
      command.manifest !== undefined
    )
      fail(403, "A subject token cannot send message.manifest", {
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
      if (workflowCancel) {
        await fenceWorkflowActions({
          t,
          workflowSessionId: id,
          turnId: cancelledTurnId,
        });
      } else if (cancelledTurnId !== null) {
        for (const a of await t.actionsForSession(id, {
          turnId: cancelledTurnId,
          statuses: ["pending", "delivering"],
        })) {
          // Delivered work may already have an external effect. Preserve it for reconciliation.
          a.status = a.status === "pending" ? "cancelled" : "uncertain";
          await t.put("actions", a.actionId, a);
          const effect = await t.get("effects", a.actionId);
          if (effect) {
            effect.status = a.status;
            await t.put("effects", a.actionId, effect);
          }
        }
      }
      if (cancelledTurnId !== null)
        for (const effect of await t.effectsForTurn<any>(
          id,
          cancelledTurnId,
          ["invoking"]
        )) {
          effect.status = "uncertain";
          effect.error =
            "Turn cancelled before model outcome was durably recorded";
          await t.put("effects", effect.request.effectId, effect);
        }
      event = await t.event(id, cancelledTurnId, "turn.cancelled", {
        reason: command.reason,
      });
      // The process running the advance aborts it on `session.cancel` (tenant/control).
      t.afterCommit(() => signalSessionCancel(ctx, id));
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
      if (command.type === "message") {
        if (!["idle", "completed", "failed", "cancelled"].includes(s.status))
          fail(409, "Session has active or unresolved work");
        // After the replay check above, so a retried message is never charged twice.
        if (scope.kind === "token" && scope.limits)
          await chargeTurn(t, scope.subject, scope.limits);
        s.turnStartState = s.state;
        s.activeTurnId = randomUUID();
        if (isWorkflowManifest(s.manifest)) {
          const input: JsonValue =
            "content" in command ? command.content : (command.data as JsonValue);
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
            rebaseSessionState(s, resolved.hash);
            s.checkpoint = createDurableCheckpoint({
              manifest: resolved.manifest,
              sessionId: id,
              turnId: s.activeTurnId,
              input:
                "content" in command
                  ? command.content
                  : typeof command.data === "string"
                  ? command.data
                  : JSON.stringify(command.data),
              state: s.state,
              info: s.info,
            });
          }
        }
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
        if (isWorkflowManifest(s.manifest)) {
          // Approvals owned by linked agent sessions must be answered there (WF-R52).
          const conflict = await foreignInteractionConflict({
            t,
            workflowSessionId: id,
            interactionId: command.interactionId,
          });
          if (conflict) fail(409, conflict.message);
          // Workflow-owned interactions (tool-node / verify) resume on this session once
          // the flow engine supports pause segments; tracer root Loop has none yet.
          fail(
            409,
            "Workflow sessions do not accept approve/respond on the root without a pending interaction"
          );
        }
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
      await t.put(
        "checkpoints",
        JSON.stringify([id, s.activeTurnId, s.checkpoint!.segment]),
        { checkpoint: s.checkpoint, status: "runnable" }
      );
      s.status = "runnable";
      s.waits = undefined;
      const commandWake = {
        reason: command.type,
        dedupeKey: `${command.type}:${s.activeTurnId}:${s.checkpoint!.segment}`,
      };
      t.afterCommit(() => ctx.wake(id, commandWake));
      event = await t.event(
        id,
        s.activeTurnId,
        `command.${command.type}`,
        command
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
        schedule: ctx.wake,
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

/**
 * Completes a delivered Action with `outcome`, in the caller's transaction, which
 * holds the lock of the Action's session `s`: the Action and its effect, the
 * `action.completed` event (and `loop.verified` or `loop.decided`), the wake that resumes the
 * turn, and queued workflow effects. The Action deliverer and the background-result callback
 * both record outcomes here. It sets `s.status`; the caller writes `s`.
 */
export async function recordActionOutcome(
  t: Tx,
  ctx: TenantContext,
  s: Session,
  action: Action,
  received: ActionOutcome,
  options: { requestId?: string } = {},
): Promise<{ event: LiveEvent; receipt: Record<string, unknown> }> {
  const outcome = acceptedOutcome(action, received);
  const prior = await t.get("effects", action.actionId);
  action.status = "completed";
  await t.put("actions", action.actionId, action);
  prior.status = "completed";
  prior.outcome = outcome;
  s.status = "runnable";
  const resultWake = {
    reason: "action_result" as const,
    dedupeKey: `action_result:${action.turnId}:${action.actionId}:${action.generation}`,
  };
  t.afterCommit(() => ctx.wake(s.id, resultWake));
  const event = await t.event(s.id, s.activeTurnId, "action.completed", {
    actionId: action.actionId,
    ...actionTarget(action),
    kind: action.kind,
    ...(action.kind === "tool" ? toolIds(action.context) : {}),
    result: outcome.value,
  });
  if (action.kind === "verify") {
    const verdict = outcome.value as {
      pass?: boolean;
      feedback?: string;
      data?: unknown;
      kind?: string;
    };
    if (verdict?.kind !== "failed") {
      await t.event(s.id, s.activeTurnId, "loop.verified", {
        path: String(action.context?.loopPath ?? action.path ?? ""),
        n: Number(action.context?.n ?? 1),
        pass: Boolean(verdict?.pass),
        ...(verdict?.feedback !== undefined
          ? { feedback: verdict.feedback }
          : {}),
        ...(verdict?.data !== undefined ? { data: verdict.data } : {}),
      });
    }
  } else if (action.kind === "fn" && action.context?.role === "decide") {
    const decision = outcome.value as {
      input?: unknown;
      output?: unknown;
      agent?: unknown;
    };
    await t.event(s.id, s.activeTurnId, "loop.decided", {
      path: String(action.context?.loopPath ?? action.path ?? ""),
      n: Number(action.context?.n ?? 1),
      next:
        "output" in decision && !("input" in decision)
          ? "output"
          : "input",
      patched: Boolean(decision.agent),
    });
  }
  const receipt = {
    status: "accepted",
    turnId: s.activeTurnId,
    cursor: event.cursor,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
  prior.receipt = receipt;
  await t.put("effects", action.actionId, prior);
  if (isWorkflowManifest(s.manifest) && s.activeTurnId) {
    await wakeForQueuedEffects({
      t,
      workflowSessionId: s.id,
      turnId: s.activeTurnId,
      limits: ctx.flowLimits,
      schedule: ctx.wake,
    });
  }
  return { event, receipt };
}
