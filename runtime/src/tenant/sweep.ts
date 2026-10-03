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
 * 3. **Sandboxes.** Idle sandboxes are stopped, records of compute no longer held are marked
 *    stopped, and sandboxes whose session or sandbox resource is gone are removed, by the
 *    workspace capability (`harness-api/workspace.ts`: here, or in the harness that serves
 *    workspaces). Idle MCP connections of the in-process harness are closed.
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
          sandboxExists: async (id) =>
            (await ctx.store.tx((t) => t.sandboxResource(id))) !== undefined,
        }),
    ],
    ["pods", () => reconcileStalePods(ctx, now)],
    // A harness elsewhere closes its own idle MCP connections.
    ["mcp", async () => ctx.mcp?.sweep()],
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

/** A pod sandbox in a change this long without a reconcile gets one from the sweep. */
const STALE_POD_MS = 60_000;

/**
 * Pod sandboxes (F7.2) whose change has not finished (creating, deleting, an old volume still
 * to delete, an expiry not yet recorded) and whose row has not moved for a minute: a reconcile
 * the `Sandbox` object lost (a send dropped while the Tenant closed) is sent again.
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
        (pod.desired === "suspended" && pod.observed !== "suspended")
      );
    }),
  );
  for (const row of stale) await ctx.sandboxSignal(row.id, { kind: "reconcile" });
}
