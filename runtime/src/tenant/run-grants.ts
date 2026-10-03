/**
 * Run grants (F5, gate trust): the run token each advance of this process holds while it owns
 * a session (`run-token.ts`). The advance mints one when it takes the lease (`grantRun`), the
 * lease heartbeat re-mints it before it expires (`renewRunGrant`), and it goes when the
 * advance ends or loses the lease (`dropRunGrant`). The HTTP gate clients read the session's
 * token on every request (`RunTokens`), so a re-mint applies to the next call.
 *
 * Only a Runtime whose gates are a service has grants (`TenantContext.runGrants`). With the
 * gates in this process nothing is minted (G6): the trust boundary is the gate's HTTP route.
 */
import type { Lease, TenantContext } from "./context.js";
import { mintRunToken, RUN_TOKEN_RENEW_SECONDS, type RunGrant } from "./run-token.js";

/** What a gate client reads: the current run token of a session, if an advance holds one. */
export interface RunTokens {
  token(sessionId: string): string | undefined;
}

/** The run grants of this process's advances, by session id. */
export interface RunGrants extends RunTokens {
  get(sessionId: string): RunGrant | undefined;
  set(grant: RunGrant): void;
  /** Forgets the grant of `sessionId` if it is the one of `epoch`: a newer advance's stays. */
  drop(sessionId: string, epoch: number): void;
}

export function createRunGrants(): RunGrants {
  const grants = new Map<string, RunGrant>();
  return {
    token: (sessionId) => grants.get(sessionId)?.token,
    get: (sessionId) => grants.get(sessionId),
    set(grant) {
      const held = grants.get(grant.claims.sessionId);
      // An older advance of the same session (a lease lost while it still ran) never replaces it.
      if (held && held.claims.epoch > grant.claims.epoch) return;
      grants.set(grant.claims.sessionId, grant);
    },
    drop(sessionId, epoch) {
      if (grants.get(sessionId)?.claims.epoch === epoch) grants.delete(sessionId);
    },
  };
}

type GrantContext = Pick<TenantContext, "keys" | "config" | "runGrants">;

/** What a run token names of the session: its root agent and the turn the advance runs. */
export interface RunOf {
  readonly agentId: string;
  readonly activeTurnId: string | null;
}

/**
 * Mints and registers the run token of the advance that just took `lease`. Nothing when the
 * gates run in this process, or the session has no active turn (it makes no gate call).
 *
 * Never throws: an advance may make no gate call at all (a model the Tenant serves itself, a
 * workflow step), so a keys service that does not answer must not stop it. Without a grant
 * the session's model calls fail as when the gateway is down, its MCP requests use core's
 * credential, and the heartbeat tries again (`renewRunGrant`).
 */
export async function grantRun(ctx: GrantContext, lease: Lease, run: RunOf): Promise<void> {
  if (!ctx.runGrants || !run.activeTurnId) return;
  try {
    ctx.runGrants.set(await mintRunToken(ctx, lease, run));
  } catch (error) {
    ctx.config.logger.warn("advance could not mint its run token", {
      sessionId: lease.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-mints the grant of `lease` when less than `RUN_TOKEN_RENEW_SECONDS` remain, or mints it
 * when the first mint failed. `active` is false once the advance ended: a token minted after
 * that is not registered.
 */
export async function renewRunGrant(
  ctx: GrantContext,
  lease: Lease,
  run: RunOf,
  active: () => boolean = () => true,
): Promise<void> {
  if (!ctx.runGrants || !run.activeTurnId) return;
  const held = ctx.runGrants.get(lease.sessionId);
  if (held && held.claims.epoch !== lease.epoch) return;
  if (held && held.claims.expiresAt - Date.now() > RUN_TOKEN_RENEW_SECONDS * 1000) return;
  const grant = await mintRunToken(ctx, lease, held ? { agentId: held.claims.agentId, activeTurnId: held.claims.turnId } : run);
  if (active()) ctx.runGrants.set(grant);
}

/** Forgets the grant of `lease` (the advance ended, or lost the lease). */
export function dropRunGrant(ctx: Pick<TenantContext, "runGrants">, lease: Lease): void {
  ctx.runGrants?.drop(lease.sessionId, lease.epoch);
}
