/**
 * Local work: the advances running on this process, for `abortLocal`, drain, reset and close.
 *
 * Scheduling itself lives behind `DurableExecution` (`ctx.wake`), the Tenant's handlers in
 * `worker.ts`, `advance.ts` and `sweep.ts`. What stays here is only what one process must
 * know about the advances it runs: their `AbortController`s, keyed by session id.
 *
 * Every abort carries an `AdvanceAbort` saying why (`worker.ts`): a cancel or a reset aborts
 * with `cancel`, closing the Tenant with `shutdown`, which leaves the session for the next
 * advance instead of settling it.
 */
import { randomUUID } from "node:crypto";
import { sleep } from "../retry.js";
import type { Session, TenantContext } from "./context.js";
import { command } from "./commands.js";
import { AdvanceAbort, type AdvanceAbortKind } from "./worker.js";

export interface WorkState {
  /** Advances running on this process, by session id. */
  readonly running: Map<string, AbortController>;
  /** The turn each running advance belongs to, by session id (`null`: none). */
  readonly runningTurns: Map<string, string | null>;
  /** Called once when the last running advance ends (`endAdvance`), then forgotten. */
  readonly idleWaiters: Set<() => void>;
}

export function createWorkState(): WorkState {
  return { running: new Map(), runningTurns: new Map(), idleWaiters: new Set() };
}

/**
 * Advance `id`'s end on this process: forgets its controller (unless a later advance of the
 * session replaced it) and, when it was the last, settles every `idle` wait.
 */
export function endAdvance(work: WorkState, id: string, controller: AbortController): void {
  if (work.running.get(id) !== controller) return;
  work.running.delete(id);
  work.runningTurns.delete(id);
  if (work.running.size > 0) return;
  for (const waiter of work.idleWaiters) waiter();
  work.idleWaiters.clear();
}

/** Resolves once no advance runs on this process, or after `timeoutMs`, whichever is first. */
async function idle(work: WorkState, timeoutMs: number): Promise<void> {
  if (work.running.size === 0) return;
  const timer = new AbortController();
  let settle!: () => void;
  const ended = new Promise<void>((resolve) => (settle = resolve));
  work.idleWaiters.add(settle);
  try {
    await Promise.race([
      ended,
      sleep(Math.max(0, timeoutMs), timer.signal),
    ]);
  } finally {
    timer.abort();
    work.idleWaiters.delete(settle);
  }
}

const MESSAGES: Record<AdvanceAbortKind, string> = {
  cancel: "Turn cancelled",
  shutdown: "The Tenant is closing",
  deadline: "The advance ran past its deadline",
  "ownership.lost": "Ownership lost",
};

function abortWith(controller: AbortController, kind: AdvanceAbortKind): void {
  if (!controller.signal.aborted)
    controller.abort(new AdvanceAbort(kind, MESSAGES[kind]));
}

/**
 * Abort the advance of `id` if it runs on this process.
 * Cancel calls it after committing `cancelled`, and so does the control bus for cancels made
 * elsewhere. With `turnId`, an advance of another turn keeps running: the signal came late.
 */
export function abortLocal(
  ctx: TenantContext,
  id: string,
  kind: AdvanceAbortKind = "cancel",
  turnId?: string
): void {
  const controller = ctx.work.running.get(id);
  if (controller && (turnId === undefined || ctx.work.runningTurns.get(id) === turnId))
    abortWith(controller, kind);
}

/** Reset: abort every advance running on this process; their sessions are being cleared. */
export function clearWork(ctx: TenantContext): void {
  abortAll(ctx, "cancel");
}

/** Stop new advances; cancel active turns if asked; wait for running advances until the timeout. */
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
  await idle(ctx.work, timeoutMs);
}

/** Abort every advance running on this process; closing the Tenant is a `shutdown`. */
export function abortAll(
  ctx: TenantContext,
  kind: AdvanceAbortKind = "shutdown"
): void {
  for (const c of ctx.work.running.values()) abortWith(c, kind);
}

/**
 * Close: wait until no advance runs on this process, for at most `timeoutMs`. Advances still
 * running then (an effect that ignores its abort signal) are abandoned and logged: they have
 * stopped renewing their lease, so it lapses and the next advance takes the session over
 * (§11.4); the epoch fences anything they still try to write. Returns their session ids.
 */
export async function waitForIdle(
  ctx: TenantContext,
  timeoutMs: number
): Promise<string[]> {
  await idle(ctx.work, timeoutMs);
  const abandoned = [...ctx.work.running.keys()];
  if (abandoned.length > 0)
    ctx.config.logger.warn("tenant closed with advances still running", {
      sessionIds: abandoned,
      waitedMs: timeoutMs,
    });
  return abandoned;
}
