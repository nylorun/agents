/**
 * The Tenant sweep (architecture §12.3, "Timers"): one self-re-arming pass per Tenant, armed
 * with `DurableExecution.armSweep` when the Tenant opens. It replaces every in-process timer
 * and startup scan the Tenant runtime used to keep:
 *
 * 1. **Linked agents.** Pending workflow `agent` effects whose linked turn already settled
 *    are completed and the workflow is woken (a crash between the two, or data written by an
 *    older Runtime). One transaction per effect, child session locked before its workflow.
 * 2. **Orphaned sessions.** `running` or `runnable` sessions with no owner, or an owner whose
 *    lease expired, are woken with reason `recover`: a wake lost between commit and send, or
 *    a Worker that died mid-advance (the advance then takes over, §11.4).
 * 3. **Sandboxes.** Idle sandboxes are stopped, records of compute this process no longer
 *    holds are marked stopped, and sandboxes whose session is gone are removed.
 * 4. **Hooks.** Callbacks registered with `ctx.onSweep`.
 * 5. **Deliveries.** Deliveries to Action endpoints whose deadline passed without an answer are
 *    lost (`delivery.ts` `loseAction`), and pending Actions of agents with an endpoint are sent
 *    again, in case a send was lost between a commit and the execution.
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
import { sweepDeliveries } from "./delivery.js";

const BATCH = 100;

type Step = [name: string, run: () => Promise<unknown>];

export async function sweep(ctx: TenantContext): Promise<void> {
  if (ctx.closing || ctx.closed) return;
  const now = new Date();
  const steps: Step[] = [
    ["deliveries", () => sweepDeliveries(ctx, now)],
    ["linked", () => reconcileLinkedAgents(ctx)],
    ["orphans", () => wakeOrphanedSessions(ctx, now)],
    [
      "sandboxes",
      () =>
        ctx.sandbox.sweep({
          now: now.getTime(),
          sessionExists: async (id) =>
            !!(await ctx.store.tx((t) => t.get("sessions", id))),
        }),
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
