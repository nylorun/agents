/**
 * Local work: the advances running on this process, for `abortLocal`, drain, reset and close.
 *
 * Scheduling itself lives behind `DurableExecution` (`ctx.wake`), the Tenant's handlers in
 * `worker.ts`, `advance.ts` and `sweep.ts`. What stays here is only what one process must
 * know about the advances it runs: their `AbortController`s, keyed by session id.
 */
import { randomUUID } from "node:crypto";
import type { Session, TenantContext } from "./context.js";
import { command } from "./commands.js";

export interface WorkState {
  /** Advances running on this process, by session id. */
  readonly running: Map<string, AbortController>;
}

export function createWorkState(): WorkState {
  return { running: new Map() };
}

/** Abort the advance of `id` if it runs on this process. */
export function abortLocal(ctx: TenantContext, id: string): void {
  ctx.work.running.get(id)?.abort();
}

/** Reset: abort every advance running on this process. */
export function clearWork(ctx: TenantContext): void {
  abortAll(ctx);
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
  const deadline = Date.now() + timeoutMs;
  while (ctx.work.running.size > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Close: abort every advance running on this process. */
export function abortAll(ctx: TenantContext): void {
  for (const c of ctx.work.running.values()) c.abort();
}

/** Close: wait until no advance runs on this process. */
export async function waitForIdle(ctx: TenantContext): Promise<void> {
  while (ctx.work.running.size)
    await new Promise((resolve) => setTimeout(resolve, 10));
}
