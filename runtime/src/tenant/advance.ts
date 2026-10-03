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
 * - **Heartbeat.** While the segment runs the lease is renewed (a column update): by the
 *   harness that holds the run (`lease.renew`), and by core until one takes it. A failed
 *   renewal aborts the segment.
 * - **Run token** (F5). Right after taking the lease the advance mints the run token its
 *   gate calls present (`run-grants.ts`); each renewal re-mints it before it expires, and it
 *   is dropped when the lease is lost or released. A harness gets it with its run.
 * - **Release** when the advance ends, whatever the outcome.
 *
 * The segment runs in a harness (Harness API v1, `harness-api/`): the advance offers it with
 * its `turn.start`, the in-process harness (or one attached to the Tenant) runs the engine and
 * reports how it ended, and the advance settles that exactly as it settled the engine's result.
 * With `NYLORUN_HARNESS_API=0` the engine runs here instead (`runSegment`), until F6.2.
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
import type { LiveEvent } from "@nylorun/core/contracts";
import {
  aggregateWaits,
  cancelSiblingWork,
  isWorkflowManifest,
  wakeLinkedWorkflow,
} from "../core/flow-host.js";
import type { AdvanceResult } from "../execution/types.js";
import type { TurnOutput } from "@nylorun/core/harness-api";
import { isOwnershipLost, ownedTx } from "../store/ownership.js";
import type { EffectDoc, Tx } from "../store/types.js";
import type { Lease, Session, TenantContext } from "./context.js";
import { linkedAgentOutput, sessionToolsOf, turnManifestOf } from "./session.js";
import {
  isRemoteMcpEffect,
  prepareMcp,
  recoversMcpCalls,
  recoversModelCalls,
} from "./effects.js";
import { resolveEffect } from "./resolve.js";
import { slimModelEffects } from "./slim.js";
import {
  applyUpdates,
  leanState,
  transcriptOf,
  transcriptShadow,
  transcriptUpdates,
  withTranscript,
  type TranscriptUpdate,
} from "./history.js";
import { command } from "./commands.js";
import { dropRunGrant, grantRun, type RunOf } from "./run-grants.js";
import { toolFixtureModel } from "../core/provider.js";
import { startHeartbeat } from "../harness-api/renew.js";
import {
  buildTurnStart,
  startSegment,
  yieldAfterOf,
  type SegmentStart,
} from "../harness-api/start.js";
import type { RunEnd } from "../harness-api/server.js";
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

/**
 * The harness holding the run went away without giving it back (`connection.lost`): an effect
 * it was running may still be running, or may have died with it. Like a Worker that died, the
 * advance keeps the lease, which lapses, so the next advance takes the session over and marks
 * what was `invoking` `uncertain` (§11.4). Never leaves `advance`.
 */
class RunLost extends Error {
  override readonly name = "RunLost";
  constructor() {
    super("The harness holding the run went away");
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

/** No harness took the segment (`HarnessApiServer.offer`): the advance is retried later. */
class HarnessUnavailable extends Error {
  override readonly name = "HarnessUnavailable";
  constructor() {
    super("No harness took the segment");
  }
}

const DONE: AdvanceResult = { status: "done" };
/** How soon an advance whose segment no harness took is tried again. */
const UNAVAILABLE_RETRY_MS = 1000;
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
  ctx.work.runningTurns.set(id, taken.session.activeTurnId ?? null);
  // A harness renews the lease once it holds the run; until then, and without one, core does.
  const run: RunOf = { agentId: taken.session.agentId, activeTurnId: taken.session.activeTurnId };
  const heartbeat = startHeartbeat(ctx, lease, controller, run);
  let result = DONE;
  let release = true;
  try {
    await grantRun(ctx, lease, run);
    if (ctx.config.harnessApi !== false)
      await runRemoteSegment(ctx, lease, taken.session, controller, run, () => heartbeat.stop());
    else await runSegment(ctx, lease, taken.session, controller.signal);
  } catch (error) {
    if (error instanceof RunLost) {
      ctx.config.logger.warn("advance lost its harness; the lease lapses and the session is taken over", {
        sessionId: id,
        epoch: lease.epoch,
      });
      release = false;
      result = { status: "busy", retryAfterMs: ctx.ownerLeaseMs };
    } else if (error instanceof HarnessUnavailable) {
      ctx.config.logger.warn("advance found no harness; session left for the next advance", {
        sessionId: id,
        epoch: lease.epoch,
      });
      result = { status: "busy", retryAfterMs: UNAVAILABLE_RETRY_MS };
    } else if (error instanceof SegmentStopped && error.kind === "shutdown") {
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
    dropRunGrant(ctx, lease);
    signal.removeEventListener("abort", forward);
    if (ctx.work.running.get(id) === controller) {
      ctx.work.running.delete(id);
      ctx.work.runningTurns.delete(id);
    }
    // Best effort: a release that fails leaves a lease that simply expires.
    if (release)
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
    if (taken.takeover)
      await takeOver(t, s, {
        recoversModelCalls: recoversModelCalls(ctx),
        recoversMcpCalls: recoversMcpCalls(ctx),
      });
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
 * owner's `invoking` effects become `uncertain` and are never invoked again, except model
 * calls when the gate recovers them (P1.2) and remote MCP calls when the Tool Gate does (F4.1
 * G3): those stay `invoking`, and the replay re-sends them. When one belongs
 * to the active turn, the session becomes `uncertain` too, with an `effect.uncertain` event.
 * Mutates and writes `s`. Returns the effect ids it marked.
 */
export async function takeOver(
  t: Tx,
  s: Session,
  options: { recoversModelCalls?: boolean; recoversMcpCalls?: boolean } = {}
): Promise<string[]> {
  const marked: string[] = [];
  for (const effect of await t.invokingEffects<
    EffectDoc & { error?: string }
  >(s.id)) {
    // Still running at the gate, or finished there: the replay re-sends it (P1.2).
    if (options.recoversModelCalls && effect.request.kind === "model") continue;
    if (options.recoversMcpCalls && isRemoteMcpEffect(s, effect.request)) continue;
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
 * Runs one segment in a harness and settles it. Throws only `ownership.lost`, `SegmentStopped`,
 * `HarnessUnavailable` and infrastructure errors. `onTaken` runs when a harness takes the run.
 */
async function runRemoteSegment(
  ctx: TenantContext,
  lease: Lease,
  started: Session,
  controller: AbortController,
  run: RunOf,
  onTaken: () => void
): Promise<void> {
  const { signal } = controller;
  let end: RunEnd | undefined;
  try {
    // prepareMcp mutates the session's mcpSnapshot; read current after it.
    if (!isWorkflowManifest(started.manifest)) await prepareMcp(ctx, lease, signal);
    const segment = await startSegment(ctx, lease, { harness: true });
    end = await ctx.harness.offer({
      lease,
      start: buildTurnStart(ctx, segment),
      controller,
      transcript: segment.transcript,
      run,
      onTaken,
    });
    if (end.kind === "unavailable") throw new HarnessUnavailable();
    // Aborted before a harness took it: settled as an abort of the engine would be.
    if (end.kind === "aborted") throw signal.reason;
    // Checked before the abort: whatever core's signal says, the run's effects are unaccounted for.
    if (end.kind === "released" && end.reason === "connection.lost") throw new RunLost();
    stopIfLeaving(signal);
    if (end.kind === "released")
      throw new SegmentStopped(end.reason === "ownership.lost" ? "ownership.lost" : "shutdown");
    const { output } = end;
    if (output.thrown) throw thrownError(output.thrown);
    const result = resultOf(output, segment);
    let cursor: number | undefined;
    if (
      signal.reason instanceof AdvanceDeadlineError &&
      (result.status === "cancelled" || result.status === "failed")
    )
      await settleFailure(ctx, lease, started, signal.reason);
    else {
      const recorded =
        result.status === "yielded" || result.status === "completed" || result.status === "paused";
      cursor = await settle(
        ctx,
        lease,
        started,
        result,
        recorded ? output.transcript ?? [] : [],
        segment.cursor
      );
    }
    end.reply(cursor === undefined ? {} : { cursor });
  } catch (error) {
    if (end?.kind === "output") end.refuse(error);
    if (
      isOwnershipLost(error) ||
      error instanceof SegmentStopped ||
      error instanceof HarnessUnavailable ||
      error instanceof RunLost
    )
      throw error;
    stopIfLeaving(signal);
    // A segment stopped by its deadline fails with the deadline, not the abort it caused.
    const deadline = signal.aborted && signal.reason instanceof AdvanceDeadlineError;
    await settleFailure(ctx, lease, started, deadline ? signal.reason : error);
  }
}

/** The error an engine threw in the harness, as it would have been thrown here. */
function thrownError(thrown: NonNullable<TurnOutput["thrown"]>): Error {
  const error = new Error(thrown.message);
  // A lost epoch stops the segment without a write, wherever it was noticed.
  return thrown.code === "ownership_lost"
    ? Object.assign(error, { code: "ownership.lost" })
    : error;
}

/**
 * A harness's output as the engine's result, so `settle` is unchanged. The checkpoint is the
 * segment's own (with the agent's new state); in shadow mode the state gets back the transcript
 * the harness edited.
 */
function resultOf(output: TurnOutput, segment: SegmentStart): SegmentResult {
  const { current } = segment;
  const status = output.status ?? "failed";
  if (status === "waiting" || status === "uncertain")
    return {
      status,
      checkpoint: current.checkpoint as DurableCheckpoint,
      effectIds: output.effectIds ?? [],
    };
  let state = output.state;
  if (state !== undefined && transcriptShadow())
    state = withTranscript(state, applyUpdates(segment.transcript, output.transcript ?? []));
  const checkpoint =
    state === undefined || isWorkflowManifest(current.manifest)
      ? current.checkpoint
      : { ...current.checkpoint!, state };
  return {
    status,
    checkpoint,
    result: {
      status,
      ...(state === undefined ? {} : { state }),
      ...(output.output === undefined ? {} : { output: output.output }),
      ...(output.pending === undefined ? {} : { pending: output.pending }),
      ...(output.error === undefined ? {} : { error: output.error }),
    },
    ...(output.cancelEffectIds ? { cancelEffectIds: output.cancelEffectIds } : {}),
  } as SegmentResult;
}

/** Runs one segment and settles it. Throws only `ownership.lost` and infrastructure errors. */
async function runSegment(
  ctx: TenantContext,
  lease: Lease,
  started: Session,
  signal: AbortSignal
): Promise<void> {
  try {
    // prepareMcp mutates the session's mcpSnapshot; read current after it.
    if (!isWorkflowManifest(started.manifest))
      await prepareMcp(ctx, lease, signal);
    const { current, fixtureModel, transcript: startTranscript } = await startSegment(ctx, lease);
    const cp = current.checkpoint as DurableCheckpoint | undefined;
    const engineCheckpoint =
      !isWorkflowManifest(current.manifest) && cp?.state
        ? { ...cp, state: withTranscript(cp.state, startTranscript) }
        : current.checkpoint;
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
          checkpoint: engineCheckpoint as DurableCheckpoint,
          signal,
          sessionTools: sessionToolsOf(current.mcpSnapshot),
          host,
          yieldAfter: yieldAfterOf(ctx),
        });
    // The engine turns an abort into a `cancelled` (agents) or `failed` (workflows) result;
    // only a user cancel may settle that, and it already did.
    stopIfLeaving(signal);
    if (
      signal.reason instanceof AdvanceDeadlineError &&
      (result.status === "cancelled" || result.status === "failed")
    )
      await settleFailure(ctx, lease, started, signal.reason);
    else {
      const state =
        !isWorkflowManifest(current.manifest) &&
        (result.status === "yielded" || result.status === "completed" || result.status === "paused") &&
        "result" in result
          ? (result.result as { state?: unknown } | undefined)?.state
          : undefined;
      const updates = state ? transcriptUpdates(startTranscript, transcriptOf(state)) : [];
      await settle(ctx, lease, started, result, updates);
    }
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
  turnId: string | null,
  type: string,
  payload: unknown
): Promise<void> {
  if (type === "turn.completed" || type === "turn.failed")
    await wakeLinkedWorkflow({
      t,
      agentSessionId: agent.id,
      turnId,
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
      turnId,
      cancelled: true,
      error: "Agent turn was cancelled",
      schedule: ctx.wake,
    });
}

/**
 * Record a segment result, then cancel failed siblings and wake a linked workflow. Returns the
 * cursor of the transcript it recorded (`cursor` when it recorded no edit), or undefined when
 * the transcript was not kept.
 */
async function settle(
  ctx: TenantContext,
  lease: Lease,
  s: Session,
  result: SegmentResult,
  updates: readonly TranscriptUpdate[] = [],
  cursor?: number
): Promise<number | undefined> {
  const id = lease.sessionId;
  let kept: number | undefined;
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
      if (result.status === "yielded") {
        // The turn goes on in a new segment: same turn, next checkpoint, woken right away.
        const finished = result.checkpoint as DurableCheckpoint;
        kept = (await recordTranscript(t, id, s.activeTurnId, current, updates)) ?? cursor;
        current.state = leanState((result.result as any).state);
        current.checkpoint = {
          ...finished,
          segment: finished.segment + 1,
          input: { kind: "continue" },
          state: current.state,
        };
        current.status = "runnable";
        current.waits = undefined;
        await slimModelEffects(t, id, s.activeTurnId);
        await t.put("sessions", id, current);
        const segment = finished.segment + 1;
        t.afterCommit(() =>
          ctx.wake(id, {
            reason: "rollover",
            dedupeKey: `rollover:${s.activeTurnId}:${segment}`,
          })
        );
        return siblings;
      }
      const flow = isWorkflowManifest(current.manifest);
      if (!flow) {
        if (result.status !== "failed") {
          const last = await recordTranscript(t, id, s.activeTurnId, current, updates);
          if (result.status !== "cancelled") kept = last ?? cursor;
        }
        current.state =
          result.status === "failed"
            ? current.turnStartState
            : leanState((result.result as any).state);
      }
      current.checkpoint = leanCheckpoint(result.checkpoint);
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
      if (result.status !== "paused") {
        current.activeTurnId = null;
        if (s.activeTurnId) current.lastTurnId = s.activeTurnId;
        await slimModelEffects(t, id, s.activeTurnId);
      }
      const type = `turn.${result.status}` as
        | "turn.completed"
        | "turn.paused"
        | "turn.failed"
        | "turn.cancelled";
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
      await wakeWorkflowOf(ctx, t, current, s.activeTurnId, type, payload);
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
  return kept;
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
    current.error = error instanceof Error ? error.message : String(error);
    const payload = { message: current.error };
    await t.event(id, current.activeTurnId, "turn.failed", payload);
    await slimModelEffects(t, id, current.activeTurnId);
    if (current.activeTurnId) current.lastTurnId = current.activeTurnId;
    current.activeTurnId = null;
    await t.put("sessions", id, current);
    await wakeWorkflowOf(
      ctx,
      t,
      current,
      s.activeTurnId,
      "turn.failed",
      payload
    );
  });
}


/** `checkpoint` with its engine state stored lean (`history.ts`). */
function leanCheckpoint<T extends object | undefined>(checkpoint: T): T {
  const state = (checkpoint as { state?: unknown } | undefined)?.state;
  if (!checkpoint || !state) return checkpoint;
  return { ...checkpoint, state: leanState(state) };
}

/**
 * Appends a segment's transcript edits; a snapshot moves `history.snapshot`. Returns the seq of
 * the last edit, if any.
 */
async function recordTranscript(
  t: Tx,
  id: string,
  turnId: string | null,
  s: Session,
  updates: readonly TranscriptUpdate[]
): Promise<number | undefined> {
  let last: number | undefined;
  for (const update of updates) {
    const event = await t.event(id, turnId, "transcript.updated", update);
    if (update.keep === 0) s.history = { from: s.history?.from ?? event.seq, snapshot: event.seq };
    last = event.seq;
  }
  return last;
}
