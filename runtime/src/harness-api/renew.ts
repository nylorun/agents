/**
 * Lease renewal of an advance (§10.6). One beat renews the session's ownership lease and
 * re-mints the run token when it nears its end (F5, `run-grants.ts`). The harness asks for a
 * beat every `renewEveryMs` (`lease.renew`) and gets the current token back; until it holds the
 * run, and on the `NYLORUN_HARNESS_API=0` path, core beats itself (`startHeartbeat`).
 *
 * A lease that cannot be renewed drops the run token and aborts the advance with
 * `ownership.lost`. Once the advance is aborted (cancel, deadline, Worker stop) a beat renews
 * nothing: an advance that does not wind down within the lease is taken over when it lapses
 * (`worker.ts`).
 */
import type { Lease, TenantContext } from "../tenant/context.js";
import { dropRunGrant, renewRunGrant, type RunOf } from "../tenant/run-grants.js";
import { AdvanceAbort } from "../tenant/worker.js";

export type Renewal = { ok: true; token?: string; tokenExpiresAt?: string } | { ok: false };

/** How often a lease is renewed: a third of its length. */
export function renewEveryMs(ctx: TenantContext): number {
  return Math.max(10, Math.floor(ctx.ownerLeaseMs / 3));
}

/** The run token the advance of `lease` holds, as a run grant carries it. */
export function tokenOf(
  ctx: TenantContext,
  lease: Lease
): { token?: string; tokenExpiresAt?: string } {
  const grant = ctx.runGrants?.get(lease.sessionId);
  if (!grant || grant.claims.epoch !== lease.epoch) return {};
  return { token: grant.token, tokenExpiresAt: new Date(grant.claims.expiresAt).toISOString() };
}

/**
 * One renewal. `active` is false once the renewing side stopped: a lease lost then aborts
 * nothing, and a token minted then is not registered. Throws when the store fails; the next
 * beat tries again.
 */
export async function beat(
  ctx: TenantContext,
  lease: Lease,
  controller: AbortController,
  run: RunOf,
  active: () => boolean = () => true
): Promise<Renewal> {
  if (controller.signal.aborted) return { ok: true };
  const renewed = await ctx.store.tx((t) =>
    t.renewOwnership(
      lease.sessionId,
      lease.owner,
      lease.epoch,
      new Date(Date.now() + ctx.ownerLeaseMs)
    )
  );
  if (!renewed) {
    if (active()) {
      // Calls under the lost lease are stale at the gate anyway; make no more of them.
      dropRunGrant(ctx, lease);
      controller.abort(new AdvanceAbort("ownership.lost", "Ownership lost"));
    }
    return { ok: false };
  }
  if (active())
    await renewRunGrant(ctx, lease, run, active).catch((error: unknown) =>
      ctx.config.logger.warn("advance failed to renew its run token", {
        sessionId: lease.sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    );
  return { ok: true, ...tokenOf(ctx, lease) };
}

/** Beats every `renewEveryMs` until stopped or the advance is aborted. */
export function startHeartbeat(
  ctx: TenantContext,
  lease: Lease,
  controller: AbortController,
  run: RunOf
): { stop(): void } {
  const every = renewEveryMs(ctx);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (controller.signal.aborted) {
      stopped = true;
      return;
    }
    try {
      const renewal = await beat(ctx, lease, controller, run, () => !stopped);
      if (!renewal.ok) {
        stopped = true;
        return;
      }
    } catch (error) {
      if (!stopped)
        ctx.config.logger.warn("advance heartbeat failed", {
          sessionId: lease.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
    }
    arm();
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), every);
    timer.unref();
  };
  arm();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
