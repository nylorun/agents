/**
 * The advance (architecture §10.5): the Tenant's `WorkerHandlers.advance`. It takes ownership
 * of the session, runs one segment of its turn with the engine its definition asks for
 * (`runDurable` for agents, `runFlowDurable` for workflows) and settles the result — status,
 * checkpoint, `turn.*` events, linked-workflow wakes and fail-fast sibling cancels — then
 * releases ownership.
 *
 * Ownership (§10.6):
 * - **Take.** One transaction takes the lease (`Tx.takeOwnership`). A live lease held by
 *   another advance returns `busy` with the time left on it; the execution re-wakes later.
 * - **Take over.** A previous owner whose lease expired without release died mid-advance:
 *   its `invoking` effects become `uncertain` with `effect.uncertain` events, in the same
 *   transaction (§11.4). This replaces the old startup recovery.
 * - **Epoch-checked writes.** Every transaction of the advance and of the engine host
 *   (`effects.ts`) runs through `ownedTx`/`ownedSession`, which checks the epoch first. A
 *   mismatch throws `ownership.lost` with no write; the advance stops and returns `done`.
 * - **Heartbeat.** While the segment runs, a timer scoped to the advance renews the lease
 *   (a column update). A failed renewal aborts the segment.
 * - **Release** when the advance ends, whatever the outcome.
 *
 * Session outcomes never throw out of `advance`: a segment that throws is settled as a
 * failed turn. Only infrastructure errors (the Session Store is unreachable) throw, and the
 * execution retries them.
 *
 * Aborts (the reasons are in `worker.ts`): a `cancel` finds the turn already cancelled and
 * settles nothing; a `deadline` settles the segment (an in-flight effect becomes `uncertain`,
 * otherwise the turn fails with the deadline's message). A `shutdown` or `ownership.lost`
 * settles nothing at all: the segment stops, whatever the engine made of the abort, and the
 * session stays `running` under its checkpoint. After a `shutdown` the advance releases
 * ownership and returns `busy`, so the next advance resumes the segment with the outcomes
 * already recorded; an `ownership.lost` leaves the session to the advance that owns it.
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
import type { AdvanceResult } from "../execution/types.js";
import { isOwnershipLost, ownedTx } from "../store/ownership.js";
import type { EffectDoc, Tx } from "../store/types.js";
import type { Lease, Session, TenantContext } from "./context.js";
import {
  linkedAgentOutput,
  rebaseSessionState,
  sessionToolsOf,
  turnManifestOf,
} from "./session.js";
import { prepareMcp, resolveEffect } from "./effects.js";
import { command } from "./commands.js";
import { usesFixtureModel } from "./model-setting.js";
import { toolFixtureModel } from "../core/provider.js";
import {
  AdvanceAbort,
  AdvanceDeadlineError,
  abortKind,
  type AdvanceAbortKind,
} from "./worker.js";

/** The model of Tenants with the fixture-model setting (`model-setting.ts`). Stateless. */
const fixture = toolFixtureModel();

/**
 * A segment stopped by a `shutdown` or `ownership.lost` abort before it settled. Never
 * leaves `advance`.
 */
class SegmentStopped extends Error {
  override readonly name = "SegmentStopped";
  constructor(readonly kind: Extract<AdvanceAbortKind, "shutdown" | "ownership.lost">) {
    super(`Segment stopped: ${kind}`);
  }
}

/** Throws `SegmentStopped` when the signal aborted for a reason that must not settle. */
function stopIfLeaving(signal: AbortSignal): void {
  const kind = abortKind(signal);
  if (kind === "shutdown" || kind === "ownership.lost") throw new SegmentStopped(kind);
}

type SegmentResult =
  | Awaited<ReturnType<typeof runDurable>>
  | Awaited<ReturnType<typeof runFlowDurable>>;

const DONE: AdvanceResult = { status: "done" };
/** Shortest `busy` retry, so a lease about to lapse is not polled in a tight loop. */
const MIN_RETRY_MS = 25;

type Taken =
  | { status: "owned"; lease: Lease; session: Session }
  | { status: "busy"; ownerExpiresAt: string }
  | { status: "idle" };

/**
 * Advance session `id` if it has a runnable checkpoint (`WorkerHandlers.advance`). Returns
 * `busy` when another advance holds a live lease, `done` otherwise.
 */
export async function advance(
  ctx: TenantContext,
  id: string,
  signal: AbortSignal
): Promise<AdvanceResult> {
  if (ctx.closing || ctx.closed) return DONE;
  const taken = await takeOwnership(ctx, id);
  if (taken.status === "busy")
    return {
      status: "busy",
      retryAfterMs: Math.min(
        Math.max(Date.parse(taken.ownerExpiresAt) - Date.now(), MIN_RETRY_MS),
        ctx.ownerLeaseMs
      ),
    };
  if (taken.status === "idle") return DONE;
  const { lease } = taken;
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  ctx.work.running.set(id, controller);
  const heartbeat = startHeartbeat(ctx, lease, controller);
  let result = DONE;
  try {
    await runSegment(ctx, lease, taken.session, controller.signal);
  } catch (error) {
    if (error instanceof SegmentStopped && error.kind === "shutdown") {
      // Left for the next advance, which resumes from the checkpoint once this one releases.
      ctx.config.logger.info("advance stopped for shutdown; session left for the next advance", {
        sessionId: id,
        epoch: lease.epoch,
      });
      result = { status: "busy", retryAfterMs: 0 };
    } else if (error instanceof SegmentStopped || isOwnershipLost(error))
      ctx.config.logger.warn("advance lost ownership", {
        sessionId: id,
        epoch: lease.epoch,
      });
    else throw error;
  } finally {
    heartbeat.stop();
    signal.removeEventListener("abort", forward);
    if (ctx.work.running.get(id) === controller) ctx.work.running.delete(id);
    // Best effort: a release that fails leaves a lease that simply expires.
    await ctx.store
      .tx((t) => t.releaseOwnership(id, lease.owner, lease.epoch))
      .catch((error) =>
        ctx.config.logger.warn("advance failed to release ownership", {
          sessionId: id,
          message: error instanceof Error ? error.message : String(error),
        })
      );
  }
  return result;
}

/**
 * Takes ownership of `id` in one transaction, takes over from a dead owner, and marks the
 * session `running` when it has a runnable checkpoint. Releases again when there is
 * nothing to run.
 */
async function takeOwnership(ctx: TenantContext, id: string): Promise<Taken> {
  const now = new Date();
  return ctx.store.tx(async (t): Promise<Taken> => {
    const taken = await t.takeOwnership(id, {
      owner: ctx.workerId,
      now,
      leaseMs: ctx.ownerLeaseMs,
    });
    if (taken.status === "missing") return { status: "idle" };
    if (taken.status === "busy")
      return { status: "busy", ownerExpiresAt: taken.ownerExpiresAt };
    const lease: Lease = {
      sessionId: id,
      owner: ctx.workerId,
      epoch: taken.epoch,
    };
    const s = await t.assertEpoch<Session>(id, taken.epoch);
    if (taken.takeover) await takeOver(t, s);
    if (!s.checkpoint || !["running", "runnable"].includes(s.status)) {
      await t.releaseOwnership(id, lease.owner, lease.epoch);
      return { status: "idle" };
    }
    s.status = "running";
    await t.put("sessions", id, s);
    return { status: "owned", lease, session: s };
  });
}

/**
 * Takeover (§10.5 step 2, §11.4), inside the transaction that took ownership: the dead
 * owner's `invoking` effects become `uncertain` and are never invoked again. When one belongs
 * to the active turn, the session becomes `uncertain` too, with an `effect.uncertain` event.
 * Mutates and writes `s`. Returns the effect ids it marked.
 */
export async function takeOver(t: Tx, s: Session): Promise<string[]> {
  const marked: string[] = [];
  for (const effect of await t.invokingEffects<
    EffectDoc & { error?: string }
  >(s.id)) {
    effect.status = "uncertain";
    effect.error ??= "The Worker running this effect stopped before its outcome was recorded";
    await t.put("effects", effect.request.effectId, effect);
    marked.push(effect.request.effectId);
    if (s.status !== "cancelled" && s.activeTurnId === effect.request.turnId) {
      s.status = "uncertain";
      await t.put("sessions", s.id, s);
      await t.event(s.id, s.activeTurnId, "effect.uncertain", {
        effectId: effect.request.effectId,
      });
    }
  }
  return marked;
}

/**
 * Renews the lease every third of its length while the advance runs; aborts it when lost.
 * Stops renewing once the advance is aborted (cancel, deadline, Worker stop): an advance that
 * does not wind down within the lease is taken over when it lapses (`worker.ts`).
 */
function startHeartbeat(
  ctx: TenantContext,
  lease: Lease,
  controller: AbortController
): { stop(): void } {
  const every = Math.max(10, Math.floor(ctx.ownerLeaseMs / 3));
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const beat = async () => {
    if (controller.signal.aborted) {
      stopped = true;
      return;
    }
    try {
      const renewed = await ctx.store.tx((t) =>
        t.renewOwnership(
          lease.sessionId,
          lease.owner,
          lease.epoch,
          new Date(Date.now() + ctx.ownerLeaseMs)
        )
      );
      if (!renewed && !stopped) {
        stopped = true;
        controller.abort(new AdvanceAbort("ownership.lost", "Ownership lost"));
        return;
      }
    } catch (error) {
      if (!stopped)
        ctx.config.logger.warn("advance heartbeat failed", {
          sessionId: lease.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
    }
    arm();
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => void beat(), every);
    timer.unref();
  };
  arm();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** Runs one segment and settles it. Throws only `ownership.lost` and infrastructure errors. */
async function runSegment(
  ctx: TenantContext,
  lease: Lease,
  started: Session,
  signal: AbortSignal
): Promise<void> {
  const id = lease.sessionId;
  try {
    // prepareMcp mutates the session's mcpSnapshot; read current after it.
    if (!isWorkflowManifest(started.manifest))
      await prepareMcp(ctx, lease, signal);
    const { current, fixtureModel } = await ownedTx<
      { current: Session; fixtureModel: boolean },
      Session
    >(ctx.store, id, lease.epoch, async (t, current) => {
      if (!isWorkflowManifest(current.manifest) && current.checkpoint) {
        rebaseSessionState(current, current.checkpoint.manifestHash);
        const cp = current.checkpoint as DurableCheckpoint;
        current.checkpoint = { ...cp, state: current.state };
        await t.put("sessions", id, current);
      }
      return { current, fixtureModel: await usesFixtureModel(t) };
    });
    const segment = fixtureModel ? { model: fixture } : {};
    const host = {
      resolveEffect: (e: HostEffect) =>
        resolveEffect(ctx, e, signal, lease, segment),
    };
    const result = isWorkflowManifest(current.manifest)
      ? await runFlowDurable({
          manifest: current.manifest,
          checkpoint: current.checkpoint as FlowCheckpoint,
          signal,
          host,
          limits: ctx.flowLimits,
        })
      : await runDurable({
          manifest: turnManifestOf(current),
          checkpoint: current.checkpoint as DurableCheckpoint,
          signal,
          sessionTools: sessionToolsOf(current.mcpSnapshot),
          host,
        });
    // The engine turns an abort into a `cancelled` (agents) or `failed` (workflows) result;
    // only a user cancel may settle that, and it already did.
    stopIfLeaving(signal);
    if (
      signal.reason instanceof AdvanceDeadlineError &&
      (result.status === "cancelled" || result.status === "failed")
    )
      await settleFailure(ctx, lease, started, signal.reason);
    else await settle(ctx, lease, started, result);
  } catch (error) {
    if (isOwnershipLost(error) || error instanceof SegmentStopped) throw error;
    stopIfLeaving(signal);
    // A segment stopped by its deadline fails with the deadline, not the abort it caused.
    const deadline =
      signal.aborted && signal.reason instanceof AdvanceDeadlineError;
    await settleFailure(ctx, lease, started, deadline ? signal.reason : error);
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
      schedule: ctx.wake,
    });
  else if (type === "turn.cancelled")
    await wakeLinkedWorkflow({
      t,
      agentSessionId: agent.id,
      cancelled: true,
      error: "Agent turn was cancelled",
      schedule: ctx.wake,
    });
}

/** Record a segment result, then cancel failed siblings and wake a linked workflow. */
async function settle(
  ctx: TenantContext,
  lease: Lease,
  s: Session,
  result: SegmentResult
): Promise<void> {
  const id = lease.sessionId;
  const siblingCancelIds = await ownedTx<string[], Session>(
    ctx.store,
    id,
    lease.epoch,
    async (t, current) => {
      const siblings: string[] = [];
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
    }
  );
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
  lease: Lease,
  s: Session,
  error: unknown
): Promise<void> {
  const id = lease.sessionId;
  await ownedTx<void, Session>(ctx.store, id, lease.epoch, async (t, current) => {
    if (
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

