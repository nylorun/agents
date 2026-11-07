/**
 * The Tenant sweep (architecture §12.3, "Timers"): one self-re-arming pass per Tenant, armed
 * with `DurableExecution.armSweep` when the Tenant opens. It replaces every in-process timer
 * and startup scan the Tenant runtime used to keep. It reconciles the Session Store with what
 * Durable Session Execution was asked to do; it never decides when a session advances:
 *
 * 1. **Outbox.** Outbox rows (`Tx.wake`, `Tx.signalSandbox`) are delivered again and deleted:
 *    a delivery after commit that failed, or that a crash between the commit and the send cut
 *    off. The first pass on this process takes every row, so a previous process's are not
 *    left waiting; later passes take those whose delivery after commit failed and those older
 *    than `sweep.outboxGraceMs` (Host tuning) (the database's clock), batch after batch within
 *    `sweep.drainBudgetMs`. Each row carries the idempotency key it was first sent with, so a
 *    request the execution did accept before the crash, or one still being sent after its
 *    commit, runs once. Rows are delivered one by one: a row that fails is retried with
 *    backoff and parked after `sweep.outboxAttempts` (`deliverOutbox`), and no delivery fails
 *    the step.
 * 2. **Linked agents.** Pending workflow `agent` effects whose linked turn already settled
 *    are completed and the workflow is woken. A linked turn's settle does both in its own
 *    transaction; this is the backstop for one that settle left pending, such as an effect
 *    an older Runtime wrote.
 * 3. **Orphaned sessions.** On this process's first pass for the Tenant, then at most every
 *    `sweep.orphanScanMs`: `running` or `runnable` sessions with no owner, or an owner whose lease
 *    expired, are woken with reason `recover`, page by page within `sweep.drainBudgetMs`; a scan
 *    the budget cut short goes on at the next pass. Neither a lost wake (step 1) nor a Worker
 *    that died mid-advance (the execution retries that advance, which takes over, §11.4)
 *    needs it: it is the backstop for what the execution itself lost or ended without an
 *    advance, such as an in-process execution's queue when its process stopped, an advance
 *    for a Tenant not open on its Worker, an invocation an operator killed, Restate's state
 *    wiped (§17.11), or a parked outbox row.
 * 4. **Sandboxes.** Idle sandboxes are stopped, records of compute no longer held are marked
 *    stopped, and sandboxes whose session or Environment is gone are removed, by the
 *    workspace feature (`harness-api/workspace.ts`: here, or in the harness that serves
 *    workspaces). Idle MCP connections of the in-process harness are closed. As often as the
 *    orphan scan, pod Environments whose change stalled get a reconcile (`reconcileStalePods`).
 *    Environments unused for their `lifecycle.deleteAfter` are deleted
 *    (`sweepUnusedAgents`).
 *    Triggers (track T4, `triggers.ts`): on this process's first pass every active trigger's
 *    timer is armed, later overdue ones only, and runs past `triggerRunRetentionMs` are deleted.
 * 5. **Control signals.** Signals on the control bus older than `sweep.signalRetentionMs` are
 *    deleted: followers read back only the last two minutes (`store/postgres/control.ts`).
 * 6. **Queues left waiting** (protocol 17): as often as the orphan scan, every session that takes
 *    messages but holds queued messages older than `sweep.queueGraceMs` gets its queue started
 *    again (`startQueuedTurn`). A queue starts when a turn ends, on a cancel, or with a new
 *    message; one whose start was refused then (its Agent's disk being copied, its pod not
 *    placed) has none of those coming, and would wait for good: an A2A task `SUBMITTED` forever.
 *    A start refused again is logged once per session on this process, with the refusal.
 * 7. **A2A pushes** (`api/a2a/push.ts`): every session with a push config still following its
 *    task is pumped (its new events become `push` outbox rows, which step 1 of the next pass, or
 *    the delivery after commit, sends), and configs of tasks long finished are deleted. A push
 *    row that fails is retried with the Host tuning's `a2a.pushRetry` and dropped once it is
 *    `a2a.pushMaxAgeMs` old, never parked: the change feed covers what it said.
 * 8. **Hooks.** Callbacks registered with `ctx.onSweep`.
 *
 * Every step runs one transaction per session it changes (a linked agent and its workflow
 * share one, child first), so the sweep follows the lock order in `store/types.ts`. A failing
 * step does not stop the others; the first error is rethrown at the end so the execution
 * reports it.
 */
import { sweepUnusedAgents } from "./agents.js";
import { reconcileTriggers } from "./triggers.js";
import { streamMissedRuns } from "./runs-stream.js";
import { sweepPendingSeeds } from "../artifacts/disk.js";
import {
  pendingAgentEffects,
  reconcilePendingAgentEffect,
} from "../core/flow-host.js";
import type { PendingRequest } from "../store/types.js";
import type { TenantContext } from "./context.js";
import { hostTuning } from "../tuning.js";
import { idleMsOf, sweepStartChecks } from "./agent-versions.js";
import { readSandboxConfig } from "../sandbox/tenant-config.js";
import { pumpPushes, pushRetry } from "../api/a2a/push.js";
import { startQueuedTurn } from "./commands.js";
import type { Session } from "./context.js";
import type { OutboxRequest } from "../store/types.js";

/*
 * The sweep's timings are the Host tuning's `sweep` group (`tuning.ts`):
 * - `outboxGraceMs`: how old an outbox row is before the sweep delivers it, unless its delivery
 *   after commit already failed (then it is due at once): longer than that delivery can take with
 *   its retries, so the sweep does not send again, and double the load on, an execution that is
 *   only slow. Sending one twice is harmless either way (the idempotency key).
 * - `orphanScanMs`: how often the orphan scan, and the stale pod sandbox check, run after the
 *   first pass of a Tenant opened on this process.
 * - `drainBudgetMs`: how long one pass may spend draining the outbox, and paging through
 *   orphaned sessions. A backlog is worked off over several passes rather than holding one (and
 *   with it the Tenant's sweep object in the execution) for long.
 * - `batchSize`, `signalRetentionMs`, `outboxAttempts`, `outboxRetry`, `stalePodMs`.
 */

/**
 * Each open Tenant's sweep state on this process: when its last orphan scan finished, the
 * last session id of one that ran out of budget, which the next pass goes on from, and when
 * the stale pod sandbox check last ran.
 */
const passes = new WeakMap<
  TenantContext,
  { orphansAt?: number; orphansAfter?: string; podsAt?: number; queuesAt?: number; queuesAfter?: string }
>();

/** The sessions whose queue's refused start this process logged, per Tenant: logged once each. */
const refusedQueues = new WeakMap<TenantContext, Set<string>>();

type Step = [name: string, run: () => Promise<unknown>];

export async function sweep(ctx: TenantContext): Promise<void> {
  if (ctx.closing || ctx.closed) return;
  const now = new Date();
  const first = !passes.has(ctx);
  const pass = passes.get(ctx) ?? {};
  passes.set(ctx, pass);
  const scanOrphans =
    pass.orphansAt === undefined ||
    pass.orphansAfter !== undefined ||
    now.getTime() - pass.orphansAt >= hostTuning().sweep.orphanScanMs;
  const checkPods = pass.podsAt === undefined || now.getTime() - pass.podsAt >= hostTuning().sweep.orphanScanMs;
  const checkQueues =
    pass.queuesAt === undefined ||
    pass.queuesAfter !== undefined ||
    now.getTime() - pass.queuesAt >= hostTuning().sweep.orphanScanMs;
  const steps: Step[] = [
    ["outbox", () => deliverOutbox(ctx, first ? 0 : hostTuning().sweep.outboxGraceMs)],
    ["linked", () => reconcileLinkedAgents(ctx)],
    ...(scanOrphans
      ? [
          [
            "orphans",
            async () => {
              const scan = await wakeOrphanedSessions(ctx, now, pass.orphansAfter);
              pass.orphansAfter = scan.next;
              if (scan.next === undefined) pass.orphansAt = now.getTime();
            },
          ] satisfies Step,
        ]
      : []),
    [
      "sandboxes",
      () =>
        ctx.sandbox.sweep({
          now: now.getTime(),
          sessionExists: async (id) =>
            !!(await ctx.store.tx((t) => t.get("sessions", id))),
          sandboxExists: async (id) =>
            (await ctx.store.tx((t) => t.environment(id))) !== undefined,
        }),
    ],
    ...(checkPods
      ? [
          [
            "pods",
            async () => {
              await reconcileStalePods(ctx, now);
              pass.podsAt = now.getTime();
            },
          ] satisfies Step,
        ]
      : []),
    ...(checkQueues
      ? [
          [
            "queues",
            async () => {
              const scan = await startWaitingQueues(ctx, now, pass.queuesAfter);
              pass.queuesAfter = scan.next;
              if (scan.next === undefined) pass.queuesAt = now.getTime();
            },
          ] satisfies Step,
        ]
      : []),
    // Environments unused for their `lifecycle.deleteAfter`: one query when none is due.
    ["agents", () => sweepUnusedAgents(ctx, now.getTime())],
    // Pods slower than `tenant.upgradeStartMs` to start on a new version go back (track T3).
    ["starts", () => sweepStartChecks(ctx, now.getTime())],
    // Triggers (track T4): every active one armed on this process's first pass, overdue ones after;
    // runs past their retention deleted.
    ["triggers", () => reconcileTriggers(ctx, first)],
    // The Tenant runs stream's outbox (D83): runs not appended after their commit.
    ["runs-stream", () => streamMissedRuns(ctx)],
    // Seeds of new volumes whose engine is connected and no process copies (R2d step 3).
    ["seeds", () => sweepPendingSeeds(ctx)],
    // A harness elsewhere closes its own idle MCP connections.
    ["mcp", async () => ctx.mcp?.sweep()],
    // A2A pushes: new events of sessions with push configs become push outbox rows.
    ["a2a-push", () => pumpPushes(ctx)],
    [
      "signals",
      () =>
        ctx.store.tx((t) => t.pruneSignals(new Date(now.getTime() - hostTuning().sweep.signalRetentionMs))),
    ],
    ...[...ctx.sweepHooks].map((hook): Step => ["hook", hook]),
  ];
  let failure: { error: unknown } | undefined;
  for (const [step, run] of steps) {
    if (ctx.closing || ctx.closed) return;
    try {
      await run();
    } catch (error) {
      ctx.config.logger.warn("tenant sweep step failed", {
        step,
        message: error instanceof Error ? error.message : String(error),
      });
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/**
 * Deliver the outbox rows that are due (`Tx.pendingOutbox`: older than `graceMs`, or whose
 * delivery failed), oldest first, batch after batch until none is left or `budgetMs` is
 * spent, and delete the delivered ones. Each row is delivered on its own: one that fails
 * (Restate refuses it, or a Runtime that does not know a wake's reason) is tried again later,
 * with backoff, so it never holds back the rows behind it, and after `sweep.outboxAttempts`
 * failures it is parked: logged once, at error, and kept in the outbox for an operator. A
 * parked wake's session is still re-woken by the orphan scan while it is runnable, and a
 * parked sandbox signal's pod by the stale pod check. A row the Tenant declines (it is
 * closing) stays as it is, and ends the drain. Never throws for a delivery; returns the rows
 * delivered.
 */
export async function deliverOutbox(
  ctx: Pick<TenantContext, "store" | "send" | "config">,
  graceMs = 0,
  budgetMs = hostTuning().sweep.drainBudgetMs
): Promise<PendingRequest[]> {
  const deadline = Date.now() + budgetMs;
  const delivered: PendingRequest[] = [];
  const batchSize = hostTuning().sweep.batchSize;
  for (;;) {
    const pending = await ctx.store.tx((t) => t.pendingOutbox(graceMs, batchSize));
    const batch: PendingRequest[] = [];
    let done = pending.length < batchSize;
    try {
      for (const row of pending) {
        if (Date.now() >= deadline) {
          done = true;
          break;
        }
        let accepted: boolean;
        try {
          accepted = await ctx.send(row.request);
        } catch (error) {
          await failed(ctx, row, error);
          continue;
        }
        if (accepted) batch.push(row);
        else done = true;
      }
    } finally {
      // Delivered ones go even when a later step fails, so they are not sent again.
      if (batch.length > 0) await ctx.store.tx((t) => t.deleteOutbox(batch));
    }
    delivered.push(...batch);
    if (done) return delivered;
  }
}

/** What a log says of an outbox request: which session, sandbox or push, never a body. */
export function outboxFields(request: OutboxRequest): Record<string, unknown> {
  return request.kind === "wake"
    ? { sessionId: request.sessionId, reason: request.wake.reason }
    : request.kind === "push"
      ? { sessionId: request.push.sessionId, taskId: request.push.taskId, pushId: request.push.id }
      : { sandboxId: request.sandboxId, signal: request.signal.kind };
}

/**
 * Records a failed delivery of `row`: retried with backoff, parked after the last attempt. An
 * A2A push is retried on its own backoff until it is too old, then deleted (`pushRetry`).
 */
async function failed(
  ctx: Pick<TenantContext, "store" | "config">,
  row: PendingRequest,
  error: unknown
): Promise<void> {
  const attempts = row.attempts + 1;
  const fields = {
    rowId: row.id,
    ...outboxFields(row.request),
    attempts,
    message: error instanceof Error ? error.message : String(error),
  };
  if (row.kind === "push") {
    const retry = pushRetry(attempts, row.createdAt);
    if (retry === "drop") {
      await ctx.store.tx((t) => t.deleteOutbox([row]));
      ctx.config.logger.warn("a2a push dropped after its last retry; the change feed covers it", fields);
    } else {
      await ctx.store.tx((t) => t.failOutbox(row, { retryInMs: retry.retryInMs, park: false }));
      ctx.config.logger.warn("a2a push failed; the sweep sends it again", fields);
    }
    return;
  }
  // Parked after `sweep.outboxAttempts` failed deliveries (`Tx.failOutbox`); tried again after
  // `outboxRetry.minMs`, doubled each time.
  const { outboxAttempts, outboxRetry } = hostTuning().sweep;
  const park = attempts >= outboxAttempts;
  const retryInMs = Math.min(outboxRetry.minMs * 2 ** (attempts - 1), outboxRetry.maxMs);
  await ctx.store.tx((t) => t.failOutbox(row, { retryInMs, park }));
  if (park) ctx.config.logger.error("outbox row parked: its delivery keeps failing", fields);
  else ctx.config.logger.warn("outbox delivery failed; the sweep tries it again", fields);
}

/** Settle pending workflow `agent` effects whose linked turn already finished. */
export async function reconcileLinkedAgents(
  ctx: Pick<TenantContext, "store">
): Promise<void> {
  const { store } = ctx;
  const effects = await store.tx((t) => pendingAgentEffects(t));
  for (const effect of effects)
    await store.tx((t) =>
      reconcilePendingAgentEffect({ t, effectId: effect.request.effectId })
    );
}

/**
 * Wake `running`/`runnable` sessions without a live owner, page after page from the first id
 * after `after`, until none is left or `budgetMs` is spent. Returns the ids woken, and the last
 * id when the budget ran out first (`next`, where the next scan goes on).
 */
export async function wakeOrphanedSessions(
  ctx: Pick<TenantContext, "store" | "wake">,
  now = new Date(),
  after?: string,
  budgetMs = hostTuning().sweep.drainBudgetMs
): Promise<{ woken: string[]; next?: string }> {
  const deadline = Date.now() + budgetMs;
  const woken: string[] = [];
  const batchSize = hostTuning().sweep.batchSize;
  let cursor = after;
  for (;;) {
    const page = await ctx.store.tx((t) => t.orphanedSessions(now, batchSize, cursor));
    for (const session of page) {
      await ctx.wake(session.id, { reason: "recover" });
      woken.push(session.id);
      cursor = session.id;
    }
    if (page.length < batchSize) return { woken };
    if (Date.now() >= deadline) return { woken, next: cursor! };
  }
}

/**
 * Starts again the queues no turn start took: sessions that take messages, holding queued messages
 * older than `sweep.queueGraceMs`, page after page from the first id after `after`, until none is
 * left or `budgetMs` is spent. Each in its own transaction under the session's lock, as a turn's
 * end starts its queue. Returns the sessions whose queue started a turn, and the last id when the
 * budget ran out first (`next`, where the next scan goes on).
 */
export async function startWaitingQueues(
  ctx: TenantContext,
  now = new Date(),
  after?: string,
  budgetMs = hostTuning().sweep.drainBudgetMs
): Promise<{ started: string[]; next?: string }> {
  const deadline = Date.now() + budgetMs;
  const started: string[] = [];
  const { batchSize, queueGraceMs } = hostTuning().sweep;
  const before = new Date(now.getTime() - queueGraceMs).toISOString();
  const logged = refusedQueues.get(ctx) ?? new Set<string>();
  refusedQueues.set(ctx, logged);
  let cursor = after;
  for (;;) {
    const page = await ctx.store.tx((t) => t.waitingQueues(before, batchSize, cursor));
    for (const { sessionId, since } of page) {
      cursor = sessionId;
      let refusal: { status: number; code?: string; message: string } | undefined;
      const turn = await ctx.store.tx(async (t) => {
        const session = await t.lockSession<Session>(sessionId);
        if (!session) return undefined;
        const begun = await startQueuedTurn(ctx, t, session, sessionId, (error) => {
          refusal = { status: error.status, ...(error.rejection.code ? { code: error.rejection.code } : {}), message: error.message };
        });
        if (begun) await t.put("sessions", sessionId, session);
        return begun;
      });
      if (turn) {
        started.push(sessionId);
        logged.delete(sessionId);
        ctx.config.logger.info("a queue left waiting started its turn", { sessionId, turnId: turn.turnId, queuedMessages: turn.taken.length, waitingSince: since });
      } else if (refusal && !logged.has(sessionId)) {
        logged.add(sessionId);
        ctx.config.logger.warn("queued messages wait: their Agent can't take a turn", { sessionId, waitingSince: since, ...refusal });
      }
    }
    if (page.length < batchSize) return { started };
    if (Date.now() >= deadline) return { started, next: cursor! };
  }
}

/**
 * Pod sandboxes (F7.2) whose change has not finished (creating, deleting, an old volume still
 * to delete, an expiry not yet recorded), that should run but whose engine is not connected, or
 * that run past their idle limit (a wake that armed no idle timer: the reconcile arms it),
 * and whose row has not moved for `sweep.stalePodMs` (a minute), get a reconcile: a pod or volume deleted outside
 * the Runtime is found, and a change goes on whose reconcile the execution itself lost (its
 * retry timer, an invocation an operator killed, Restate's state wiped) or whose outbox row
 * was parked. A reconcile a commit asked for is never lost: it is in the outbox.
 */
async function reconcileStalePods(ctx: TenantContext, now: Date): Promise<void> {
  if (!ctx.pods) return;
  const stale = await ctx.store.tx(async (t) => {
    const config = await readSandboxConfig(t);
    return (await t.listEnvironments()).filter((row) => {
      const pod = row.pod;
      if (!pod || now.getTime() - Date.parse(row.updatedAt) < hostTuning().sweep.stalePodMs) return false;
      return (
        pod.desired === "deleted" ||
        pod.retiring !== undefined ||
        pod.observed === "creating" ||
        pod.observed === "deleting" ||
        (pod.desired === "suspended" && pod.observed !== "suspended") ||
        // Running, but its engine is not connected: the pod may be gone, or its volume.
        (pod.desired === "running" && pod.observed === "running" && !ctx.harness.hosting(row.id)) ||
        // Running past its idle limit: its idle timer is missing (or a turn holds it, which the
        // reconcile leaves alone).
        (pod.desired === "running" &&
          pod.observed === "running" &&
          now.getTime() - Date.parse(pod.lastActiveAt ?? row.createdAt) >
            idleMsOf(config, row) + hostTuning().sweep.stalePodMs)
      );
    });
  });
  for (const row of stale) await ctx.sandboxSignal(row.id, { kind: "reconcile" });
}
