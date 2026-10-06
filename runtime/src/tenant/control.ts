/**
 * The control bus of an open Tenant (blueprint D21, D48): the signals one process sends the
 * others with the Tenant open, on Postgres (`Tx.signal`, `SessionStore.followSignals`). They
 * never go through S2, which only serves API listeners.
 *
 * - `session.cancel` is written by the cancel's own transaction (`commands.ts`): every process
 *   aborts the cancelled turn's advance if it runs there (`ctx.abortLocal`).
 * - `sessions.reset` is written by the reset's transaction (`reset.ts`): every process moves
 *   its session streams to the new basin generation and ends those of deleted sessions
 *   (`checkSessionStreams`).
 *
 * A lost signal costs latency, never correctness: the advance checks the Session Store before
 * every effect, and the session streams are checked periodically (`streams.ts`).
 */
import type { TenantContext } from "./context.js";
import { checkSessionStreams } from "./session-streams.js";

export interface WireControlOptions {
  /** How often the follower reads recent signals back (`FollowSignalsOptions.pollMs`). */
  pollMs?: number;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Follows the control bus for this process and keeps the follower on `ctx.control`. Call it
 * once, after `ctx` is built; signals committed from its return on reach this process.
 */
export async function wireControl(
  ctx: TenantContext,
  options: WireControlOptions = {}
): Promise<void> {
  if (ctx.control) throw new Error("The control bus is already wired");
  let closed = false;
  // Nothing is reported once closed: the Tenant (and its log directory) may be gone.
  const report = (what: string) => (error: unknown) => {
    if (!closed) ctx.config.logger.warn(what, { message: messageOf(error) });
  };
  const follower = await ctx.store.followSignals(
    (signal) => {
      if (signal.type === "session.cancel") ctx.abortLocal(signal.sessionId, signal.turnId);
      else void checkSessionStreams(ctx).catch(report("session stream check failed"));
    },
    {
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      onError: report("control bus unavailable; retrying"),
    }
  );
  ctx.control = {
    async close() {
      closed = true;
      await follower.close();
    },
  };
}

/** Close: stops following the control bus. */
export async function closeControl(ctx: TenantContext): Promise<void> {
  await ctx.control?.close();
}
