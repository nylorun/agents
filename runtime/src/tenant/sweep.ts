/**
 * The Tenant sweep (architecture §12.3, "Timers"): one self-re-arming pass per Tenant, armed
 * with `DurableExecution.armSweep` when the Tenant opens. It replaces every in-process timer
 * and startup scan the Tenant runtime used to keep:
 *
 * 1. **Claim expiry.** Claimed Actions whose lease lapsed: `hook`, `fn` and `verify` are
 *    pure or repeat-safe and are offered again (the next claim bumps the generation, which
 *    fences a late result); `tool` claims become `uncertain`, with `action.uncertain`.
 *    On the first pass after the Tenant opens, claimed `fn`/`verify` Actions are offered
 *    again without waiting for their lease: their executor belonged to an earlier process.
 * 2. **Linked agents.** Pending workflow `agent` effects whose linked turn already settled
 *    are completed and the workflow is woken (a crash between the two, or data written by an
 *    older Runtime). One transaction per effect, child session locked before its workflow.
 * 3. **Orphaned sessions.** `running` or `runnable` sessions with no owner, or an owner whose
 *    lease expired, are woken with reason `recover`: a wake lost between commit and send, or
 *    a Worker that died mid-advance (the advance then takes over, §11.4).
 * 4. **Sandboxes.** Idle sandboxes are stopped, records of compute this process no longer
 *    holds are marked stopped, and sandboxes whose session is gone are removed.
 * 5. **Hooks.** Callbacks registered with `ctx.onSweep` (the outbox drain, Wave 2 / Y).
 * 6. **Deliveries.** Deliveries to Action endpoints whose deadline passed without an answer are
 *    lost (`delivery.ts` `loseAction`), and pending Actions of agents with an endpoint are sent
 *    again, in case a send was lost between a commit and the execution.
 *
 * Every step runs one transaction per session it changes (a linked agent and its workflow
 * share one, child first), so the sweep follows the lock order in `store/types.ts`. A failing
 * step does not stop the others; the first error is rethrown at the end so the execution
 * reports it.
 */
import type { Action } from "@nylorun/core/contracts";
import {
  claimedFnVerifyActions,
  pendingAgentEffects,
  reconcilePendingAgentEffect,
  reofferFnVerifyClaim,
} from "../core/flow-host.js";
import type { Session, TenantContext } from "./context.js";
import { sweepDeliveries } from "./delivery.js";

const BATCH = 100;

type Step = [name: string, run: () => Promise<unknown>];

export async function sweep(
  ctx: TenantContext,
  options: { afterOpen?: boolean } = {}
): Promise<void> {
  if (ctx.closing || ctx.closed) return;
  const now = new Date();
  const steps: Step[] = [
    ...(options.afterOpen
      ? [["reoffer", () => reofferFnVerifyClaims(ctx)] satisfies Step]
      : []),
    ["claims", () => expireClaims(ctx, now)],
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

/**
 * Expire lapsed Action claims: hooks, fn and verify are offered again, tools become
 * `uncertain`. One transaction per claim, so each locks only its own session.
 */
export async function expireClaims(
  ctx: Pick<TenantContext, "store">,
  now = new Date()
): Promise<number> {
  const { store } = ctx;
  const seen = new Set<string>();
  let expiredCount = 0;
  for (;;) {
    const expired = (
      await store.tx((t) => t.expiredClaims(now, BATCH))
    ).filter((action) => !seen.has(action.actionId));
    for (const found of expired) {
      seen.add(found.actionId);
      const changed = await store.tx(async (t) => {
        const s = await t.lockSession<Session>(found.sessionId);
        // Read again under the session lock: a heartbeat or result may have won.
        const action = await t.get<Action>("actions", found.actionId);
        if (
          !action ||
          action.status !== "claimed" ||
          Date.parse(action.leaseExpiresAt!) > now.getTime()
        )
          return false;
        if (
          action.kind === "hook" ||
          action.kind === "fn" ||
          action.kind === "verify"
        ) {
          action.status = "pending";
          action.claimId = null;
          action.leaseExpiresAt = null;
          await t.put("actions", action.actionId, action);
          t.signalWork();
          return true;
        }
        action.status = "uncertain";
        await t.put("actions", action.actionId, action);
        const effect = await t.get("effects", action.actionId);
        if (effect) {
          effect.status = "uncertain";
          await t.put("effects", action.actionId, effect);
        }
        if (s && s.status !== "cancelled" && s.activeTurnId === action.turnId) {
          s.status = "uncertain";
          await t.put("sessions", s.id, s);
          await t.event(s.id, s.activeTurnId, "action.uncertain", {
            actionId: action.actionId,
            ...(action.agent ? { agent: action.agent } : {}),
          });
        }
        return true;
      });
      if (changed) expiredCount += 1;
    }
    if (expired.length < BATCH) return expiredCount;
  }
}

/** Offer claimed `fn`/`verify` Actions again, one transaction each. Returns how many. */
export async function reofferFnVerifyClaims(
  ctx: Pick<TenantContext, "store">
): Promise<number> {
  const claimed = await ctx.store.tx((t) => claimedFnVerifyActions(t));
  let count = 0;
  for (const action of claimed)
    if (await ctx.store.tx((t) => reofferFnVerifyClaim(t, action.actionId)))
      count += 1;
  return count;
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
