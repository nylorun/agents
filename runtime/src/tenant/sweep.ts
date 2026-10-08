/**
 * The Tenant sweep (architecture §12.3, "Timers"): one self-re-arming pass per Tenant, armed
 * with `DurableExecution.armSweep` when the Tenant opens. It replaces every in-process timer
 * and startup scan the Tenant runtime used to keep. It reconciles the Session Store with what
 * Durable Session Execution was asked to do; it never decides when a session advances:
 *
 * 1. **Wakes.** Wake outbox rows (`Tx.wake`) are delivered again and deleted: a delivery
 *    after commit that failed, or that a crash between the commit and the send cut off. The
 *    first pass on this process takes every row, so a previous process's are not left
 *    waiting; later passes take the rows older than `WAKE_GRACE_MS`. Each row carries the
 *    idempotency key it was first sent with, so a wake the execution did accept before the
 *    crash, or one still being sent after its commit, causes no second advance.
 * 2. **Linked agents.** Pending workflow `agent` effects whose linked turn already settled
 *    are completed and the workflow is woken (a crash between the two, or data written by an
 *    older Runtime).
 * 3. **Orphaned sessions.** On this process's first pass for the Tenant, then at most every
 *    `ORPHAN_SCAN_MS`: `running` or `runnable` sessions with no owner, or an owner whose lease
 *    expired, are woken with reason `recover`. Neither a lost wake (step 1) nor a Worker that
 *    died mid-advance (the execution retries that advance, which takes over, §11.4) needs it:
 *    it is the backstop for what the execution itself lost or ended without an advance, such
 *    as an in-process execution's queue when its process stopped, an advance for a Tenant not
 *    open on its Worker, an invocation an operator killed, or Restate's state wiped (§17.11).
 * 4. **Sandboxes.** Idle sandboxes are stopped, records of compute no longer held are marked
 *    stopped, and sandboxes whose session or sandbox resource is gone are removed, by the
 *    workspace capability (`harness-api/workspace.ts`: here, or in the harness that serves
 *    workspaces). Idle MCP connections of the in-process harness are closed.
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
import type { TenantContext } from "./context.js";

const BATCH = 100;
/** How long a control signal is kept after it was written. */
const SIGNAL_RETENTION_MS = 60 * 60 * 1000;
/**
 * How old a wake outbox row is before the sweep delivers it: longer than a delivery after
 * commit takes, so the sweep seldom sends a wake its commit is still sending. Sending one
 * twice is harmless either way (the idempotency key).
 */
export const WAKE_GRACE_MS = 2000;
/** How often the orphan scan runs after the first pass of a Tenant opened on this process. */
export const ORPHAN_SCAN_MS = 60_000;

/** Each open Tenant's sweep state on this process: when its orphan scan last ran. */
const passes = new WeakMap<TenantContext, { orphansAt?: number }>();

type Step = [name: string, run: () => Promise<unknown>];

export async function sweep(ctx: TenantContext): Promise<void> {
  if (ctx.closing || ctx.closed) return;
  const now = new Date();
  const first = !passes.has(ctx);
  const pass = passes.get(ctx) ?? {};
  passes.set(ctx, pass);
  const scanOrphans =
    pass.orphansAt === undefined || now.getTime() - pass.orphansAt >= ORPHAN_SCAN_MS;
  const steps: Step[] = [
    [
      "wakes",
      () =>
        deliverPendingWakes(ctx, first ? now : new Date(now.getTime() - WAKE_GRACE_MS)),
    ],
    ["linked", () => reconcileLinkedAgents(ctx)],
    ...(scanOrphans
      ? [
          [
            "orphans",
            async () => {
              await wakeOrphanedSessions(ctx, now);
              pass.orphansAt = now.getTime();
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
    ["pods", () => reconcileStalePods(ctx, now)],
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

/**
 * Deliver the wake outbox rows written before `before` (oldest first, one batch) and delete
 * the delivered ones. A row the Tenant declines (it is closing) stays. Returns the ids of the
 * rows delivered.
 */
export async function deliverPendingWakes(
  ctx: Pick<TenantContext, "store" | "wake">,
  before = new Date()
): Promise<string[]> {
  const pending = await ctx.store.tx((t) => t.pendingWakes(before, BATCH));
  const delivered: string[] = [];
  try {
    for (const row of pending)
      if ((await ctx.wake(row.sessionId, row.wake)) !== false) delivered.push(row.id);
  } finally {
    // Delivered ones go even when a later one fails, so they are not sent again.
    if (delivered.length > 0) await ctx.store.tx((t) => t.deleteWakes(delivered));
  }
  return delivered;
}

/** Settle pending workflow `agent` effects whose linked turn already finished. */
export async function reconcileLinkedAgents(
  ctx: Pick<TenantContext, "store" | "wake">
): Promise<void> {
  const { store } = ctx;
  const effects = await store.tx((t) => pendingAgentEffects(t));
  for (const effect of effects)
    await store.tx((t) =>
      reconcilePendingAgentEffect({
        t,
        effectId: effect.request.effectId,
        schedule: ctx.wake,
      })
    );
}

/** Wake `running`/`runnable` sessions without a live owner. Returns the ids woken. */
export async function wakeOrphanedSessions(
  ctx: Pick<TenantContext, "store" | "wake">,
  now = new Date()
): Promise<string[]> {
  const orphans = await ctx.store.tx((t) => t.orphanedSessions(now, BATCH));
  const ids = orphans.map((session) => session.id);
  for (const id of ids) await ctx.wake(id, { reason: "recover" });
  return ids;
}

/** A pod sandbox in a change this long without a reconcile gets one from the sweep. */
const STALE_POD_MS = 60_000;

/**
 * Pod sandboxes (F7.2) whose change has not finished (creating, deleting, an old volume still
 * to delete, an expiry not yet recorded), or that should run but whose engine is not connected,
 * and whose row has not moved for a minute: a reconcile the `Sandbox` object lost (a send
 * dropped while the Tenant closed) is sent again, and a pod or volume deleted outside the
 * Runtime is found.
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
