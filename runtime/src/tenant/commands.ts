/**
 * The session command service: `message`, `approve`/`respond`, `action_result` and `cancel`,
 * with per-session idempotency keys. A command commits its state change and event in one
 * transaction, then publishes, aborts a cancelled advance, cascades workflow cancels, and
 * asks for an advance through `ctx.schedule`.
 *
 * Later waves: Wave 1 / A makes the transaction async and replaces the `store.all` scans
 * with typed queries; Wave 2 / X routes the abort through `DurableExecution.abortLocal`
 * and the control stream.
 */
import { randomUUID } from "node:crypto";
import type {
  Action,
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
  fenceWorkflowActions,
  foreignInteractionConflict,
  isWorkflowManifest,
  planCancelCascade,
  wakeForQueuedEffects,
  wakeLinkedWorkflow,
} from "../core/flow-host.js";
import { resolveMessageManifest } from "../core/turn-manifest.js";
import { canonical } from "../core/store.js";
import {
  sessionOf,
  type AuthScope,
  type Session,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";
import { scoped } from "./auth.js";
import {
  actionTarget,
  rebaseSessionState,
  turnManifestOf,
  variantStore,
} from "./session.js";

/** A tool result whose output does not match the Action's stored output schema fails the tool. */
function acceptedToolResult(
  action: Action,
  command: Extract<SessionCommand, { type: "action_result" }>
): Extract<SessionCommand, { type: "action_result" }> {
  if (action.kind !== "tool" || !action.outputSchema) return command;
  const value = command.outcome.value;
  if (isFailedToolValue(value)) return command;
  // Executors wrap successful tool output as `{ kind: "completed", output }`.
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
  if (matches) return command;
  return {
    ...command,
    outcome: {
      ...command.outcome,
      value: {
        kind: "failed",
        code: "tool.invalid-output",
        message:
          "Tool result does not match the output schema stored on the action",
      },
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

function isFailedToolValue(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "failed"
  );
}

/** A command's identity for idempotency: everything but the request id. */
const semantic = (value: any): string => {
  const { requestId: _, ...body } = value;
  return canonical(body);
};

export function command(
  ctx: TenantContext,
  id: string,
  input: SessionCommand,
  scope: AuthScope
): unknown {
  const { store } = ctx;
  let event: LiveEvent | undefined;
  const extraEvents: LiveEvent[] = [];
  const cascadeCancelIds: string[] = [];
  let schedule = false;
  const response = store.tx(() => {
    const s = sessionOf(ctx, id);
    let command = input;
    if (command.type === "action_result") {
      const a =
        store.get<Action>("actions", command.actionId) ??
        fail(404, "Action not found");
      if (a.sessionId !== id) fail(403, "Action belongs to another session");
      scoped(scope, a);
      command = acceptedToolResult(a, command);
    } else if (scope.kind !== "application")
      fail(403, "Application credential required");
    const key = JSON.stringify([id, command.idempotencyKey]);
    const existing = store.get("commands", key);
    if (existing) {
      if (semantic(existing.command) !== semantic(command))
        fail(409, "Idempotency key already binds another command");
      return existing.response;
    }
    if (command.type === "action_result") {
      const action = store.get<Action>("actions", command.actionId)!;
      const prior = store.get("effects", command.actionId);
      if (action.status === "completed") {
        if (
          action.claimId !== command.claimId ||
          action.generation !== command.generation ||
          canonical(prior.outcome) !== canonical(command.outcome)
        )
          fail(409, "Conflicting action result");
        store.put("commands", key, { command, response: prior.receipt });
        return prior.receipt;
      }
      if (
        s.status === "cancelled" ||
        s.activeTurnId !== action.turnId ||
        action.status !== "claimed" ||
        action.claimId !== command.claimId ||
        action.generation !== command.generation ||
        Date.parse(action.leaseExpiresAt!) <= Date.now()
      )
        fail(409, "Stale, expired, or cancelled claim");
      action.status = "completed";
      store.put("actions", action.actionId, action);
      prior.status = "completed";
      prior.outcome = command.outcome;
      s.status = "runnable";
      schedule = true;
      event = store.event(id, s.activeTurnId, "action.completed", {
        actionId: action.actionId,
        ...actionTarget(action),
        kind: action.kind,
        result: command.outcome.value,
      });
      if (action.kind === "verify") {
        const verdict = command.outcome.value as {
          pass?: boolean;
          feedback?: string;
          data?: unknown;
          kind?: string;
        };
        if (verdict?.kind !== "failed") {
          extraEvents.push(
            store.event(id, s.activeTurnId, "loop.verified", {
              path: String(action.context?.loopPath ?? action.path ?? ""),
              n: Number(action.context?.n ?? 1),
              pass: Boolean(verdict?.pass),
              ...(verdict?.feedback !== undefined
                ? { feedback: verdict.feedback }
                : {}),
              ...(verdict?.data !== undefined ? { data: verdict.data } : {}),
            })
          );
        }
      } else if (action.kind === "fn" && action.context?.role === "decide") {
        const decision = command.outcome.value as {
          input?: unknown;
          output?: unknown;
          agent?: unknown;
        };
        extraEvents.push(
          store.event(id, s.activeTurnId, "loop.decided", {
            path: String(action.context?.loopPath ?? action.path ?? ""),
            n: Number(action.context?.n ?? 1),
            next:
              "output" in decision && !("input" in decision)
                ? "output"
                : "input",
            patched: Boolean(decision.agent),
          })
        );
      }
      const receipt = {
        status: "accepted",
        turnId: s.activeTurnId,
        cursor: event.cursor,
        requestId: command.requestId,
      };
      prior.receipt = receipt;
      store.put("effects", action.actionId, prior);
      if (isWorkflowManifest(s.manifest) && s.activeTurnId) {
        wakeForQueuedEffects({
          store,
          workflowSessionId: id,
          turnId: s.activeTurnId,
          limits: ctx.flowLimits,
          schedule: (sid) => {
            schedule = true;
            void sid;
          },
        });
      }
    } else if (command.type === "cancel") {
      const cancelledTurnId = s.activeTurnId;
      const workflowCancel = isWorkflowManifest(s.manifest);
      const cascade = workflowCancel
        ? planCancelCascade({
            store,
            workflowSessionId: id,
            turnId: cancelledTurnId,
          })
        : null;
      s.status = "cancelled";
      if (workflowCancel) {
        fenceWorkflowActions({
          store,
          workflowSessionId: id,
          turnId: cancelledTurnId,
        });
      } else {
        for (const a of store.all<Action>("actions"))
          if (
            a.sessionId === id &&
            a.turnId === cancelledTurnId &&
            ["pending", "claimed"].includes(a.status)
          ) {
            // Claimed work may already have an external effect. Preserve it for reconciliation.
            a.status = a.status === "claimed" ? "uncertain" : "cancelled";
            store.put("actions", a.actionId, a);
            const effect = store.get("effects", a.actionId);
            effect.status = a.status;
            store.put("effects", a.actionId, effect);
          }
      }
      for (const effect of store.all("effects"))
        if (
          effect.request.sessionId === id &&
          effect.request.turnId === cancelledTurnId &&
          effect.status === "invoking"
        ) {
          effect.status = "uncertain";
          effect.error =
            "Turn cancelled before model outcome was durably recorded";
          store.put("effects", effect.request.effectId, effect);
        }
      event = store.event(id, cancelledTurnId, "turn.cancelled", {
        reason: command.reason,
      });
      s.activeTurnId = null;
      // The next turn starts from the state preceding the cancelled turn, never its paused plan.
      if (cancelledTurnId !== null) s.state = s.turnStartState;
      s.checkpoint = undefined;
      s.waits = undefined;
      s.error = undefined;
      // Cascade: cancel linked agent sessions deepest-first (after fencing this session).
      if (cascade) {
        for (const agentId of cascade.agentSessionIds) {
          const agent = store.get<Session>("sessions", agentId);
          if (
            !agent ||
            !agent.activeTurnId ||
            ["idle", "completed", "failed", "cancelled"].includes(agent.status)
          )
            continue;
          cascadeCancelIds.push(agentId);
        }
      }
    } else {
      if (command.type === "message") {
        if (!["idle", "completed", "failed", "cancelled"].includes(s.status))
          fail(409, "Session has active or unresolved work");
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
          const conflict = foreignInteractionConflict({
            store,
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
      store.put(
        "checkpoints",
        JSON.stringify([id, s.activeTurnId, s.checkpoint!.segment]),
        { checkpoint: s.checkpoint, status: "runnable" }
      );
      s.status = "runnable";
      s.waits = undefined;
      schedule = true;
      event = store.event(
        id,
        s.activeTurnId,
        `command.${command.type}`,
        command
      );
    }
    store.put("sessions", id, s);
    const response = {
      status: "accepted",
      turnId: s.activeTurnId,
      cursor: event?.cursor ?? store.history(id).cursor,
      requestId: command.requestId,
    };
    store.put("commands", key, { command, response });
    return response;
  });
  if (event) ctx.publish(event);
  for (const extra of extraEvents) ctx.publish(extra);
  if (input.type === "cancel") ctx.abortLocal(id);
  // Cascade cancel linked agents deepest-first under existing fencing (WF-R53).
  for (const agentId of cascadeCancelIds) {
    try {
      command(
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
  // Direct cancel of a linked agent fails that node with agent.cancelled (WF-R54).
  if (input.type === "cancel") {
    const link = store.get("links", id);
    if (link) {
      store.tx(() => {
        wakeLinkedWorkflow({
          agentSessionId: id,
          store,
          cancelled: true,
          error: "Agent turn was cancelled",
          schedule: (sid) => ctx.schedule(sid),
          publish: (e) => ctx.publish(e),
        });
      });
    }
  }
  if (schedule) ctx.schedule(id);
  return response;
}
