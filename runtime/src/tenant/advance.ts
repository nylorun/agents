/**
 * The advance: run one segment of a session's turn with the engine its definition asks for
 * (`runDurable` for agents, `runFlowDurable` for workflows) and settle the result — status,
 * checkpoint, `turn.*` events, linked-workflow wakes and fail-fast sibling cancels.
 *
 * Later waves: Wave 1 / A makes every transaction here async; Wave 2 / X adds ownership
 * (take, epoch-checked writes, heartbeat, release) and calls `execute` from the Worker
 * handler behind `DurableExecution` instead of from `scheduler.ts`.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import {
  runDurable,
  runFlowDurable,
  type DurableCheckpoint,
  type FlowCheckpoint,
  type HostEffect,
} from "@nylorun/harness/run";
import type { JsonValue } from "@nylorun/core/define";
import {
  aggregateWaits,
  cancelSiblingWork,
  isWorkflowManifest,
  wakeLinkedWorkflow,
} from "../core/flow-host.js";
import { sessionOf, type Session, type TenantContext } from "./context.js";
import {
  linkedAgentOutput,
  rebaseSessionState,
  sessionToolsOf,
  turnManifestOf,
} from "./session.js";
import { prepareMcp, resolveEffect } from "./effects.js";
import { command } from "./commands.js";

type SegmentResult =
  | Awaited<ReturnType<typeof runDurable>>
  | Awaited<ReturnType<typeof runFlowDurable>>;

/** Advance session `id` if it has a runnable checkpoint. Session outcomes never throw out. */
export async function execute(ctx: TenantContext, id: string): Promise<void> {
  const { store } = ctx;
  const s = sessionOf(ctx, id);
  if (!s.checkpoint || !["running", "runnable"].includes(s.status)) return;
  s.status = "running";
  store.tx(() => store.put("sessions", id, s));
  const controller = new AbortController();
  ctx.work.running.set(id, controller);
  try {
    // prepareMcp mutates the session's mcpSnapshot; read current after it.
    if (!isWorkflowManifest(sessionOf(ctx, id).manifest))
      await prepareMcp(ctx, id, controller.signal);
    const current = sessionOf(ctx, id);
    const host = {
      resolveEffect: (e: HostEffect) =>
        resolveEffect(ctx, e, controller.signal),
    };
    if (!isWorkflowManifest(current.manifest) && current.checkpoint) {
      rebaseSessionState(current, current.checkpoint.manifestHash);
      const cp = current.checkpoint as DurableCheckpoint;
      current.checkpoint = { ...cp, state: current.state };
      store.tx(() => store.put("sessions", id, current));
    }
    const result = isWorkflowManifest(current.manifest)
      ? await runFlowDurable({
          manifest: current.manifest,
          checkpoint: current.checkpoint as FlowCheckpoint,
          signal: controller.signal,
          host,
          limits: ctx.flowLimits,
        })
      : await runDurable({
          manifest: turnManifestOf(current),
          checkpoint: current.checkpoint as DurableCheckpoint,
          signal: controller.signal,
          sessionTools: sessionToolsOf(current.mcpSnapshot),
          host,
        });
    settle(ctx, id, s, result);
  } catch (error) {
    settleFailure(ctx, id, s, error);
  } finally {
    ctx.work.running.delete(id);
    if (
      !ctx.closing &&
      (ctx.work.pending.has(id) || sessionOf(ctx, id).status === "runnable")
    )
      ctx.schedule(id);
  }
}

/** Record a segment result, then cancel failed siblings and wake a linked workflow. */
function settle(
  ctx: TenantContext,
  id: string,
  s: Session,
  result: SegmentResult
): void {
  const { store } = ctx;
  let event: LiveEvent | undefined;
  const siblingCancelIds: string[] = [];
  store.tx(() => {
    const current = sessionOf(ctx, id);
    if (
      current.status === "cancelled" ||
      current.activeTurnId !== s.activeTurnId
    )
      return;
    // A result can arrive during concurrent action persistence. Preserve the runnable marker.
    const resumeRequested = current.status === "runnable";
    if (result.status === "waiting" || result.status === "uncertain") {
      const linkedWaits = isWorkflowManifest(current.manifest)
        ? aggregateWaits({
            store,
            workflowSessionId: id,
          })
        : [];
      if (linkedWaits.length > 0 && !resumeRequested) {
        current.status = "paused";
        current.waits = linkedWaits;
      } else {
        current.status = resumeRequested
          ? "runnable"
          : current.status === "uncertain"
          ? "uncertain"
          : result.status;
        current.waits =
          linkedWaits.length > 0 ? linkedWaits : { effectIds: result.effectIds };
      }
    } else if ("result" in result) {
      const flow = isWorkflowManifest(current.manifest);
      if (!flow) {
        current.state =
          result.status === "failed"
            ? current.turnStartState
            : (result.result as any).state;
      }
      current.checkpoint = result.checkpoint;
      store.put(
        "checkpoints",
        JSON.stringify([id, s.activeTurnId, result.checkpoint.segment]),
        { checkpoint: result.checkpoint, status: result.status }
      );
      current.status = result.status;
      current.waits =
        result.status === "paused" ? (result.result as any).pending : undefined;
      if (result.status === "completed")
        current.lastOutput = (result.result as any).output;
      // Fail-fast: cancel pending Parallel/Map siblings before clearing the turn.
      if (
        result.status === "failed" &&
        flow &&
        "cancelEffectIds" in result &&
        Array.isArray(result.cancelEffectIds) &&
        result.cancelEffectIds.length > 0 &&
        s.activeTurnId
      ) {
        const cancelResult = cancelSiblingWork({
          store,
          workflowSessionId: id,
          turnId: s.activeTurnId,
          cancelEffectIds: result.cancelEffectIds,
        });
        siblingCancelIds.push(...cancelResult.agentSessionIds);
      }
      if (result.status !== "paused") current.activeTurnId = null;
      event = store.event(
        id,
        s.activeTurnId,
        `turn.${result.status}`,
        result.status === "completed"
          ? { output: (result.result as any).output }
          : result.status === "paused"
          ? {
              interactions: ((result.result as any).pending ?? []).map(
                (call: any) => ({
                  invocationId: call.invocationId,
                  interaction: call.interaction,
                  wait: call.wait,
                  status: call.status,
                })
              ),
            }
          : result.status === "failed"
          ? {
              error: {
                code: (result.result as any).error?.code,
                message: (result.result as any).error?.message,
                ...((result.result as any).error?.path
                  ? { path: (result.result as any).error.path }
                  : {}),
              },
            }
          : {}
      );
    }
    store.put("sessions", id, current);
  });
  for (const agentId of siblingCancelIds) {
    try {
      command(
        ctx,
        agentId,
        {
          type: "cancel",
          requestId: `flow-sibling-${id}-${agentId}`,
          idempotencyKey: `flow-sibling-cancel:${id}:${agentId}:${s.activeTurnId}`,
          reason: "sibling branch failed",
        },
        {
          kind: "application",
          principalId: "flow-host",
        }
      );
    } catch {
      /* agent may already be terminal */
    }
  }
  if (event) {
    ctx.publish(event);
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      store.tx(() => {
        wakeLinkedWorkflow({
          agentSessionId: id,
          store,
          output:
            event!.type === "turn.completed"
              ? linkedAgentOutput(
                  sessionOf(ctx, id),
                  (event!.payload as { output?: JsonValue }).output
                )
              : undefined,
          failed: event!.type === "turn.failed",
          error:
            event!.type === "turn.failed"
              ? String((event!.payload as { message?: string }).message ?? "")
              : undefined,
          schedule: (sid) => ctx.schedule(sid),
          publish: (e) => ctx.publish(e),
        });
      });
    }
    if (event.type === "turn.cancelled") {
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
}

/** A segment threw: fail the turn, restore the turn-start state, wake a linked workflow. */
function settleFailure(
  ctx: TenantContext,
  id: string,
  s: Session,
  error: unknown
): void {
  const { store } = ctx;
  let event: LiveEvent | undefined;
  store.tx(() => {
    const current = sessionOf(ctx, id);
    if (
      current.status === "cancelled" ||
      current.activeTurnId !== s.activeTurnId
    )
      return;
    current.status = "failed";
    current.state = current.turnStartState;
    if (current.checkpoint)
      store.put(
        "checkpoints",
        JSON.stringify([id, s.activeTurnId, current.checkpoint.segment]),
        { checkpoint: current.checkpoint, status: "failed" }
      );
    current.error = error instanceof Error ? error.message : String(error);
    store.put("sessions", id, current);
    event = store.event(id, current.activeTurnId, "turn.failed", {
      message: current.error,
    });
    current.activeTurnId = null;
    store.put("sessions", id, current);
  });
  if (event) {
    ctx.publish(event);
    store.tx(() => {
      wakeLinkedWorkflow({
        agentSessionId: id,
        store,
        failed: true,
        error: String((event!.payload as { message?: string }).message ?? ""),
        schedule: (sid) => ctx.schedule(sid),
        publish: (e) => ctx.publish(e),
      });
    });
  }
}
