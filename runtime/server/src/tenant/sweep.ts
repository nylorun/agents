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
 *    than `OUTBOX_GRACE_MS` (the database's clock), batch after batch within
 *    `DRAIN_BUDGET_MS`. Each row carries the idempotency key it was first sent with, so a
 *    request the execution did accept before the crash, or one still being sent after its
 *    commit, runs once. Rows are delivered one by one: a row that fails is retried with
 *    backoff and parked after `MAX_OUTBOX_ATTEMPTS` (`deliverOutbox`), and no delivery fails
 *    the step.
 * 2. **Linked agents.** Pending workflow `agent` effects whose linked turn already settled
 *    are completed and the workflow is woken. A linked turn's settle does both in its own
 *    transaction; this is the backstop for one that settle left pending, such as an effect
 *    an older Runtime wrote.
 * 3. **Orphaned sessions.** On this process's first pass for the Tenant, then at most every
 *    `ORPHAN_SCAN_MS`: `running` or `runnable` sessions with no owner, or an owner whose lease
 *    expired, are woken with reason `recover`, page by page within `DRAIN_BUDGET_MS`; a scan
 *    the budget cut short goes on at the next pass. Neither a lost wake (step 1) nor a Worker
 *    that died mid-advance (the execution retries that advance, which takes over, §11.4)
 *    needs it: it is the backstop for what the execution itself lost or ended without an
 *    advance, such as an in-process execution's queue when its process stopped, an advance
 *    for a Tenant not open on its Worker, an invocation an operator killed, Restate's state
 *    wiped (§17.11), or a parked outbox row.
 * 4. **Sandboxes.** Idle sandboxes are stopped, records of compute no longer held are marked
 *    stopped, and sandboxes whose session or sandbox resource is gone are removed, by the
 *    workspace capability (`harness-api/workspace.ts`: here, or in the harness that serves
 *    workspaces). Idle MCP connections of the in-process harness are closed. As often as the
 *    orphan scan, pod sandboxes whose change stalled get a reconcile (`reconcileStalePods`).
 * 5. **Control signals.** Signals on the control bus older than `SIGNAL_RETENTION_MS` are
 *    deleted: followers read back only the last two minutes (`store/postgres/control.ts`).
 * 6. **Hooks.** Callbacks registered with `ctx.onSweep`.
 *
 * Every step runs one transaction per session it changes (a linked agent and its workflow
 * share one, child first), so the sweep follows the lock order in `store/types.ts`. A failing
 * step does not stop the others; the first error is rethrown at the end so the execution
 * reports it.
 */
import {
  pendingAgentEffects,
  reconcilePendingAgentEffect,
} from "../core/flow-host.js";
import type { PendingRequest } from "../store/types.js";
import type { TenantContext } from "./context.js";

const BATCH = 100;
/** How long a control signal is kept after it was written. */
const SIGNAL_RETENTION_MS = 60 * 60 * 1000;
/**
 * How old an outbox row is before the sweep delivers it, unless its delivery after commit
 * already failed (then it is due at once): longer than that delivery can take with its
 * retries, so the sweep does not send again, and double the load on, an execution that is
 * only slow. Sending one twice is harmless either way (the idempotency key).
 */
export const OUTBOX_GRACE_MS = 30_000;
/**
 * How often the orphan scan, and the stale pod sandbox check, run after the first pass of a
 * Tenant opened on this process.
 */
export const ORPHAN_SCAN_MS = 60_000;
/**
 * How long one pass may spend draining the outbox, and paging through orphaned sessions.
 * A backlog is worked off over several passes rather than holding one (and with it the
 * Tenant's sweep object in the execution) for long.
 */
export const DRAIN_BUDGET_MS = 2000;

/**
 * Each open Tenant's sweep state on this process: when its last orphan scan finished, the
 * last session id of one that ran out of budget, which the next pass goes on from, and when
 * the stale pod sandbox check last ran.
 */
const passes = new WeakMap<
  TenantContext,
  { orphansAt?: number; orphansAfter?: string; podsAt?: number }
>();

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
    now.getTime() - pass.orphansAt >= ORPHAN_SCAN_MS;
  const checkPods = pass.podsAt === undefined || now.getTime() - pass.podsAt >= ORPHAN_SCAN_MS;
  const steps: Step[] = [
    ["outbox", () => deliverOutbox(ctx, first ? 0 : OUTBOX_GRACE_MS)],
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
            (await ctx.store.tx((t) => t.sandboxResource(id))) !== undefined,
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
    // A harness elsewhere closes its own idle MCP connections.
    ["mcp", async () => ctx.mcp?.sweep()],
    [
      "signals",
      () =>
        ctx.store.tx((t) => t.pruneSignals(new Date(now.getTime() - SIGNAL_RETENTION_MS))),
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

/** Failed deliveries after which the sweep parks an outbox row (`Tx.failOutbox`). */
export const MAX_OUTBOX_ATTEMPTS = 10;
/** How long after its first failed delivery the sweep tries a row again; doubled each time. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 10 * 60_000;

/**
 * Deliver the outbox rows that are due (`Tx.pendingOutbox`: older than `graceMs`, or whose
 * delivery failed), oldest first, batch after batch until none is left or `budgetMs` is
 * spent, and delete the delivered ones. Each row is delivered on its own: one that fails
 * (Restate refuses it, or a Runtime that does not know a wake's reason) is tried again later,
 * with backoff, so it never holds back the rows behind it, and after `MAX_OUTBOX_ATTEMPTS`
 * failures it is parked: logged once, at error, and kept in the outbox for an operator. A
 * parked wake's session is still re-woken by the orphan scan while it is runnable, and a
 * parked sandbox signal's pod by the stale pod check. A row the Tenant declines (it is
 * closing) stays as it is, and ends the drain. Never throws for a delivery; returns the rows
 * delivered.
 */
export async function deliverOutbox(
  ctx: Pick<TenantContext, "store" | "send" | "config">,
  graceMs = 0,
  budgetMs = DRAIN_BUDGET_MS
): Promise<PendingRequest[]> {
  const deadline = Date.now() + budgetMs;
  const delivered: PendingRequest[] = [];
  for (;;) {
    const pending = await ctx.store.tx((t) => t.pendingOutbox(graceMs, BATCH));
    const batch: PendingRequest[] = [];
    let done = pending.length < BATCH;
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

/** Records a failed delivery of `row`: retried with backoff, parked after the last attempt. */
async function failed(
  ctx: Pick<TenantContext, "store" | "config">,
  row: PendingRequest,
  error: unknown
): Promise<void> {
  const attempts = row.attempts + 1;
  const park = attempts >= MAX_OUTBOX_ATTEMPTS;
  const retryInMs = Math.min(RETRY_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  await ctx.store.tx((t) => t.failOutbox(row, { retryInMs, park }));
  const { request } = row;
  const fields = {
    rowId: row.id,
    ...(request.kind === "wake"
      ? { sessionId: request.sessionId, reason: request.wake.reason }
      : { sandboxId: request.sandboxId, signal: request.signal.kind }),
    attempts,
    message: error instanceof Error ? error.message : String(error),
  };
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
  budgetMs = DRAIN_BUDGET_MS
): Promise<{ woken: string[]; next?: string }> {
  const deadline = Date.now() + budgetMs;
  const woken: string[] = [];
  let cursor = after;
  for (;;) {
    const page = await ctx.store.tx((t) => t.orphanedSessions(now, BATCH, cursor));
    for (const session of page) {
      await ctx.wake(session.id, { reason: "recover" });
      woken.push(session.id);
      cursor = session.id;
    }
    if (page.length < BATCH) return { woken };
    if (Date.now() >= deadline) return { woken, next: cursor! };
  }
}

/** A pod sandbox in a change this long without a reconcile gets one from the sweep. */
const STALE_POD_MS = 60_000;

/**
 * Pod sandboxes (F7.2) whose change has not finished (creating, deleting, an old volume still
 * to delete, an expiry not yet recorded), or that should run but whose engine is not connected,
 * and whose row has not moved for a minute, get a reconcile: a pod or volume deleted outside
 * the Runtime is found, and a change goes on whose reconcile the execution itself lost (its
 * retry timer, an invocation an operator killed, Restate's state wiped) or whose outbox row
 * was parked. A reconcile a commit asked for is never lost: it is in the outbox.
 */
async function reconcileStalePods(ctx: TenantContext, now: Date): Promise<void> {
  if (!ctx.pods) return;
  const stale = await ctx.store.tx(async (t) =>
    (await t.listSandboxResources()).filter((row) => {
      const pod = row.pod;
      if (!pod || now.getTime() - Date.parse(row.updatedAt) < STALE_POD_MS) return false;
      const expiring =
        pod.expiresAt !== undefined && Date.parse(pod.expiresAt) <= now.getTime() && pod.observed !== "expired";
      return (
        pod.desired === "deleted" ||
        pod.retiring !== undefined ||
        pod.observed === "creating" ||
        pod.observed === "deleting" ||
        expiring ||
        (pod.desired === "suspended" && pod.observed !== "suspended") ||
        // Running, but its engine is not connected: the pod may be gone, or its volume.
        (pod.desired === "running" && pod.observed === "running" && !ctx.harness.hosting(row.id))
      );
    }),
  );
  for (const row of stale) await ctx.sandboxSignal(row.id, { kind: "reconcile" });
}
