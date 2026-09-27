/**
 * The advance: run one segment of a session's turn with the engine its definition asks for
 * (`runDurable` for agents, `runFlowDurable` for workflows) and settle the result — status,
 * checkpoint, `turn.*` events, linked-workflow wakes and fail-fast sibling cancels.
 *
 * Every read-modify-write of the session runs in one transaction that locks it first; the
 * engine runs between transactions. A linked agent's settle wakes its workflow in the same
 * transaction (agent session locked before the workflow session, per `store/types.ts`).
 *
 * Later waves: Wave 2 / X adds ownership (take, epoch-checked writes, heartbeat, release)
 * and calls `execute` from the Worker handler behind `DurableExecution` instead of from
 * `scheduler.ts`.
 */
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
import type { Tx } from "../store/types.js";
import {
  lockedSession,
  type Session,
  type TenantContext,
} from "./context.js";
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
  // Registered before the first await so a second wake waits for this advance.
  const controller = new AbortController();
  ctx.work.running.set(id, controller);
  let s: Session | undefined;
  try {
    s = await store.tx(async (t) => {
      const s = await t.lockSession<Session>(id);
      if (!s || !s.checkpoint || !["running", "runnable"].includes(s.status))
        return undefined;
      s.status = "running";
      await t.put("sessions", id, s);
      return s;
    });
  } catch (error) {
    ctx.work.running.delete(id);
    if (!ctx.closing)
      ctx.config.logger.warn("advance failed to start", {
        sessionId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    return;
  }
  if (!s) {
    ctx.work.running.delete(id);
    if (!ctx.closing && ctx.work.pending.has(id)) ctx.schedule(id);
    return;
  }
  const started = s;
  try {
    // prepareMcp mutates the session's mcpSnapshot; read current after it.
    if (!isWorkflowManifest(started.manifest))
      await prepareMcp(ctx, id, controller.signal);
    const current = await store.tx(async (t) => {
      const current = await lockedSession(t, id);
      if (!isWorkflowManifest(current.manifest) && current.checkpoint) {
        rebaseSessionState(current, current.checkpoint.manifestHash);
        const cp = current.checkpoint as DurableCheckpoint;
        current.checkpoint = { ...cp, state: current.state };
        await t.put("sessions", id, current);
      }
      return current;
    });
    const host = {
      resolveEffect: (e: HostEffect) =>
        resolveEffect(ctx, e, controller.signal),
    };
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
    await settle(ctx, id, started, result);
  } catch (error) {
    await settleFailure(ctx, id, started, error).catch((failure) =>
      ctx.config.logger.warn("advance failed to settle", {
        sessionId: id,
        message: failure instanceof Error ? failure.message : String(failure),
      })
    );
  } finally {
    ctx.work.running.delete(id);
    if (!ctx.closing) {
      const again =
        ctx.work.pending.has(id) ||
        (await store
          .tx(async (t) => (await t.get<Session>("sessions", id))?.status)
          .catch(() => undefined)) === "runnable";
      if (again && !ctx.closing) ctx.schedule(id);
    }
  }
}

/** Wake the workflow a linked agent belongs to, in the agent's settle transaction. */
async function wakeWorkflowOf(
  ctx: TenantContext,
  t: Tx,
  agent: Session,
  type: string,
  payload: unknown
): Promise<void> {
  if (type === "turn.completed" || type === "turn.failed")
    await wakeLinkedWorkflow({
      t,
      agentSessionId: agent.id,
      output:
        type === "turn.completed"
          ? linkedAgentOutput(
              agent,
              (payload as { output?: JsonValue }).output
            )
          : undefined,
      failed: type === "turn.failed",
      error:
        type === "turn.failed"
          ? String((payload as { message?: string }).message ?? "")
          : undefined,
      schedule: (sid) => ctx.schedule(sid),
    });
  else if (type === "turn.cancelled")
    await wakeLinkedWorkflow({
      t,
      agentSessionId: agent.id,
      cancelled: true,
      error: "Agent turn was cancelled",
      schedule: (sid) => ctx.schedule(sid),
    });
}

/** Record a segment result, then cancel failed siblings and wake a linked workflow. */
async function settle(
  ctx: TenantContext,
  id: string,
  s: Session,
  result: SegmentResult
): Promise<void> {
  const siblingCancelIds = await ctx.store.tx(async (t) => {
    const siblings: string[] = [];
    const current = await lockedSession(t, id);
    if (
      current.status === "cancelled" ||
      current.activeTurnId !== s.activeTurnId
    )
      return siblings;
    // A result can arrive during concurrent action persistence. Preserve the runnable marker.
    const resumeRequested = current.status === "runnable";
    if (result.status === "waiting" || result.status === "uncertain") {
      const linkedWaits = isWorkflowManifest(current.manifest)
        ? await aggregateWaits({ t, workflowSessionId: id })
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
      await t.put("sessions", id, current);
      return siblings;
    }
    if (!("result" in result)) {
      await t.put("sessions", id, current);
      return siblings;
    }
    const flow = isWorkflowManifest(current.manifest);
    if (!flow) {
      current.state =
        result.status === "failed"
          ? current.turnStartState
          : (result.result as any).state;
    }
    current.checkpoint = result.checkpoint;
    await t.put(
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
      const cancelResult = await cancelSiblingWork({
        t,
        workflowSessionId: id,
        turnId: s.activeTurnId,
        cancelEffectIds: result.cancelEffectIds,
      });
      siblings.push(...cancelResult.agentSessionIds);
    }
    if (result.status !== "paused") current.activeTurnId = null;
    const type = `turn.${result.status}`;
    const payload =
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
        : {};
    await t.event(id, s.activeTurnId, type, payload);
    await t.put("sessions", id, current);
    await wakeWorkflowOf(ctx, t, current, type, payload);
    return siblings;
  });
  for (const agentId of siblingCancelIds) {
    try {
      await command(
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
}

/** A segment threw: fail the turn, restore the turn-start state, wake a linked workflow. */
async function settleFailure(
  ctx: TenantContext,
  id: string,
  s: Session,
  error: unknown
): Promise<void> {
  await ctx.store.tx(async (t) => {
    const current = await t.lockSession<Session>(id);
    if (
      !current ||
      current.status === "cancelled" ||
      current.activeTurnId !== s.activeTurnId
    )
      return;
    current.status = "failed";
    current.state = current.turnStartState;
    if (current.checkpoint)
      await t.put(
        "checkpoints",
        JSON.stringify([id, s.activeTurnId, current.checkpoint.segment]),
        { checkpoint: current.checkpoint, status: "failed" }
      );
    current.error = error instanceof Error ? error.message : String(error);
    const payload = { message: current.error };
    await t.event(id, current.activeTurnId, "turn.failed", payload);
    current.activeTurnId = null;
    await t.put("sessions", id, current);
    await wakeWorkflowOf(ctx, t, current, "turn.failed", payload);
  });
}

