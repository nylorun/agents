/**
 * In-process scheduling of advances and lease upkeep: `schedule` with its `pending`/`running`
 * sets, the claim-lease interval (`expireClaims`), startup recovery (`invoking` effects become
 * `uncertain`), the re-offer of orphaned fn/verify claims, reschedule-on-open, and drain.
 *
 * Business code asks for an advance through `ctx.schedule`, never by calling `schedule` here.
 *
 * Later waves: Wave 2 / X replaces this module. `schedule`, `pending`, `running` and the
 * interval move behind an in-process `DurableExecution` (with `abortLocal`), `expireClaims`
 * and reconcile move into the Tenant sweep, and takeover replaces the startup recovery.
 */
import { randomUUID } from "node:crypto";
import type { Action, LiveEvent } from "@nylorun/core/contracts";
import {
  reconcilePendingAgentEffects,
  reofferOrphanedFnVerifyClaims,
} from "../core/flow-host.js";
import { sessionOf, type Session, type TenantContext } from "./context.js";
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

/** Expire lapsed Action claims: hooks/fn/verify are re-offered, tools become `uncertain`. */
export function expireClaims(ctx: TenantContext): void {
  const { store } = ctx;
  const events: LiveEvent[] = [];
  let redeliver = false;
  store.tx(() => {
    for (const action of store.all<Action>("actions"))
      if (
        action.status === "claimed" &&
        Date.parse(action.leaseExpiresAt!) <= Date.now()
      ) {
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
          store.put("actions", action.actionId, action);
          redeliver = true;
          continue;
        }
        action.status = "uncertain";
        store.put("actions", action.actionId, action);
        const effect = store.get("effects", action.actionId);
        effect.status = "uncertain";
        store.put("effects", action.actionId, effect);
        const s = sessionOf(ctx, action.sessionId);
        if (s.status !== "cancelled" && s.activeTurnId === action.turnId) {
          s.status = "uncertain";
          store.put("sessions", s.id, s);
          events.push(
            store.event(s.id, s.activeTurnId, "action.uncertain", {
              actionId: action.actionId,
              ...(action.agent ? { agent: action.agent } : {}),
            })
          );
        }
      }
  });
  events.forEach((e) => ctx.publish(e));
  if (redeliver) ctx.notify();
}

/**
 * Startup recovery, before any advance runs: effects left `invoking` by a previous process
 * become `uncertain`, expired claims lapse, and orphaned fn/verify claims are offered again.
 */
export function recoverOnOpen(ctx: TenantContext): void {
  const { store } = ctx;
  store.tx(() => {
    for (const effect of store.all("effects"))
      if (effect.status === "invoking") {
        effect.status = "uncertain";
        store.put("effects", effect.request.effectId, effect);
        const sess = store.get<Session>("sessions", effect.request.sessionId);
        if (
          sess &&
          sess.status !== "cancelled" &&
          sess.activeTurnId === effect.request.turnId
        ) {
          sess.status = "uncertain";
          store.put("sessions", sess.id, sess);
          store.event(sess.id, sess.activeTurnId, "effect.uncertain", {
            effectId: effect.request.effectId,
          });
        }
      }
  });
  expireClaims(ctx);
  // Orphaned fn/verify claims from a prior process: re-offer immediately.
  store.tx(() => {
    reofferOrphanedFnVerifyClaims(store);
  });
  ctx.notify();
}

/** The claim-lease interval; the caller clears it on close. */
export function startLeaseTimer(ctx: TenantContext): NodeJS.Timeout {
  const timer = setInterval(
    () => expireClaims(ctx),
    Math.min(ctx.config.leaseMs ?? 30000, 5000)
  );
  timer.unref();
  return timer;
}

/** Wake sessions a previous process left running or runnable, and settle linked agents. */
export function rescheduleOnOpen(ctx: TenantContext): void {
  const { store } = ctx;
  for (const sess of store.all<Session>("sessions"))
    if (sess.status === "running" || sess.status === "runnable")
      ctx.schedule(sess.id);
  store.tx(() => {
    reconcilePendingAgentEffects({
      store,
      schedule: (sid) => ctx.schedule(sid),
      publish: (e) => ctx.publish(e),
    });
  });
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
    for (const sess of ctx.store.all<Session>("sessions"))
      if (
        sess.activeTurnId &&
        ["running", "runnable", "paused"].includes(sess.status)
      )
        command(
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
