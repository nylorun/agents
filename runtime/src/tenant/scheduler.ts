/**
 * In-process scheduling of advances and lease upkeep: `schedule` with its `pending`/`running`
 * sets, the claim-lease interval (`expireClaims`), startup recovery (`invoking` effects become
 * `uncertain`), the re-offer of orphaned fn/verify claims, reschedule-on-open, and drain.
 *
 * Business code asks for an advance through `ctx.schedule`, from `t.afterCommit`, never by
 * calling `schedule` here.
 *
 * Later waves: Wave 2 / X replaces this module. `schedule`, `pending`, `running` and the
 * interval move behind an in-process `DurableExecution` (with `abortLocal`), `expireClaims`
 * and reconcile move into the Tenant sweep, and takeover replaces the startup recovery.
 */
import { randomUUID } from "node:crypto";
import type { Action } from "@nylorun/core/contracts";
import {
  reconcilePendingAgentEffects,
  reofferOrphanedFnVerifyClaims,
} from "../core/flow-host.js";
import type { EffectDoc } from "../store/types.js";
import type { Session, TenantContext } from "./context.js";
import { execute } from "./advance.js";
import { command } from "./commands.js";

export interface WorkState {
  /** Advances running in this process, by session id. */
  readonly running: Map<string, AbortController>;
  /** Sessions with a wake queued for the next tick. */
  readonly pending: Set<string>;
}

export function createWorkState(): WorkState {
  return { running: new Map(), pending: new Set() };
}

/** Queue an advance of `id` for the next tick; a running advance re-checks when it ends. */
export function schedule(ctx: TenantContext, id: string): void {
  if (ctx.closing) return;
  ctx.work.pending.add(id);
  setImmediate(() => {
    if (
      !ctx.work.running.has(id) &&
      ctx.work.pending.delete(id) &&
      !ctx.closing
    )
      void execute(ctx, id);
  });
}

/** Abort the advance of `id` if it runs in this process. */
export function abortLocal(ctx: TenantContext, id: string): void {
  ctx.work.running.get(id)?.abort();
}

const CLAIM_BATCH = 100;

/**
 * Expire lapsed Action claims: hooks/fn/verify are re-offered, tools become `uncertain`.
 * One transaction per claim, so each locks only its own session.
 */
export async function expireClaims(ctx: TenantContext): Promise<void> {
  const { store } = ctx;
  const seen = new Set<string>();
  for (;;) {
    const now = new Date();
    const expired = (
      await store.tx((t) => t.expiredClaims(now, CLAIM_BATCH))
    ).filter((action) => !seen.has(action.actionId));
    for (const found of expired) {
      seen.add(found.actionId);
      await store.tx(async (t) => {
        const s = await t.lockSession<Session>(found.sessionId);
        const action = await t.get<Action>("actions", found.actionId);
        if (
          !action ||
          action.status !== "claimed" ||
          Date.parse(action.leaseExpiresAt!) > Date.now()
        )
          return;
        if (
          action.kind === "hook" ||
          action.kind === "fn" ||
          action.kind === "verify"
        ) {
          // Hooks, fn and verify are pure / repeat-safe; a lost claim is offered again.
          // The next claim bumps the generation, which fences any late result.
          action.status = "pending";
          action.claimId = null;
          action.leaseExpiresAt = null;
          await t.put("actions", action.actionId, action);
          t.signalWork();
          return;
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
      });
    }
    if (expired.length < CLAIM_BATCH) return;
  }
}

/**
 * Startup recovery, before any advance runs: effects left `invoking` by a previous process
 * become `uncertain`, expired claims lapse, and orphaned fn/verify claims are offered again.
 */
export async function recoverOnOpen(ctx: TenantContext): Promise<void> {
  const { store } = ctx;
  const invoking = await store.tx((t) =>
    t.effectsWithStatus<EffectDoc>(["invoking"])
  );
  for (const found of invoking)
    await store.tx(async (t) => {
      const sess = await t.lockSession<Session>(found.request.sessionId);
      const effect = await t.get("effects", found.request.effectId);
      if (!effect || effect.status !== "invoking") return;
      effect.status = "uncertain";
      await t.put("effects", found.request.effectId, effect);
      if (
        sess &&
        sess.status !== "cancelled" &&
        sess.activeTurnId === found.request.turnId
      ) {
        sess.status = "uncertain";
        await t.put("sessions", sess.id, sess);
        await t.event(sess.id, sess.activeTurnId, "effect.uncertain", {
          effectId: found.request.effectId,
        });
      }
    });
  await expireClaims(ctx);
  // Orphaned fn/verify claims from a prior process: re-offer immediately.
  await store.tx(async (t) => {
    await reofferOrphanedFnVerifyClaims(t);
    t.signalWork();
  });
}

/** The claim-lease interval; the caller clears it on close. */
export function startLeaseTimer(ctx: TenantContext): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (ctx.closed) return;
    expireClaims(ctx).catch((error) =>
      ctx.config.logger.warn("claim expiry failed", {
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }, Math.min(ctx.config.leaseMs ?? 30000, 5000));
  timer.unref();
  return timer;
}

/** Wake sessions a previous process left running or runnable, and settle linked agents. */
export async function rescheduleOnOpen(ctx: TenantContext): Promise<void> {
  const { store } = ctx;
  const open = await store.tx((t) =>
    t.sessionsWithStatus(["running", "runnable"])
  );
  for (const sess of open) ctx.schedule(sess.id);
  await store.tx((t) =>
    reconcilePendingAgentEffects({
      t,
      schedule: (sid) => ctx.schedule(sid),
    })
  );
}

/** Reset: forget queued wakes and abort every running advance. */
export function clearWork(ctx: TenantContext): void {
  ctx.work.pending.clear();
  for (const c of ctx.work.running.values()) c.abort();
  ctx.work.running.clear();
}

/** Stop scheduling; cancel active turns if asked; wait for running advances until the timeout. */
export async function drain(
  ctx: TenantContext,
  activeWork: "drain" | "cancel",
  timeoutMs: number
): Promise<void> {
  ctx.closing = true;
  if (activeWork === "cancel") {
    const active = await ctx.store.tx((t) =>
      t.sessionsWithStatus<Session>(["running", "runnable", "paused"])
    );
    for (const sess of active)
      if (sess.activeTurnId)
        await command(
          ctx,
          sess.id,
          {
            type: "cancel",
            requestId: randomUUID(),
            idempotencyKey: `drain-cancel-${sess.id}-${sess.activeTurnId}`,
            reason: "tenant drain cancel",
          },
          {
            kind: "application",
            principalId: "drain",
          }
        );
  }
  const deadline = Date.now() + timeoutMs;
  while (ctx.work.running.size > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Close: abort every running advance. */
export function abortAll(ctx: TenantContext): void {
  for (const c of ctx.work.running.values()) c.abort();
}

/** Close: wait until no advance runs in this process. */
export async function waitForIdle(ctx: TenantContext): Promise<void> {
  while (ctx.work.running.size)
    await new Promise((resolve) => setTimeout(resolve, 10));
}
