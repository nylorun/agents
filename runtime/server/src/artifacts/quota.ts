/**
 * What one artifact write must fit (`tenant/limits.ts`): the largest file, and each total its
 * bytes count towards. The Tenant's total always applies; an artifact of an Environment (one of
 * its sessions' artifacts, or one of its disk versions) also counts towards that Environment's
 * total when its manifest sets `limits.artifacts.totalBytes`. Without one, the Environment's
 * total is the Tenant's, which the Tenant's own check already enforces.
 */
import type { Tx } from "../store/types.js";
import { limitsInForce, readTenantLimits } from "../tenant/limits.js";

/** One total a write counts towards: the Tenant's (no `environmentId`), or an Environment's. */
export interface ArtifactTotal {
  readonly environmentId?: string;
  readonly limitBytes: number;
}

export interface ArtifactQuota {
  /** The largest file the write may store. */
  readonly fileBytes: number;
  /** The Tenant's total first, then the Environment's when it sets one. */
  readonly totals: readonly ArtifactTotal[];
}

/** A total, with the bytes it holds now. */
export interface ArtifactUsage {
  readonly total: ArtifactTotal;
  readonly usedBytes: number;
}

/** The quota for an artifact of `environmentId`, or of the Tenant alone when undefined. */
export async function artifactQuota(t: Tx, environmentId: string | undefined): Promise<ArtifactQuota> {
  const tenant = await readTenantLimits(t);
  const set = environmentId === undefined ? undefined : (await t.environment(environmentId))?.applied.limits;
  const inForce = limitsInForce(tenant, set);
  return {
    fileBytes: inForce.artifacts.fileBytes,
    totals: [
      { limitBytes: tenant.artifacts.totalBytes },
      ...(environmentId !== undefined && set?.artifacts?.totalBytes !== undefined
        ? [{ environmentId, limitBytes: inForce.artifacts.totalBytes }]
        : []),
    ],
  };
}

/** The bytes each of the quota's totals holds now. */
export async function artifactUsage(t: Tx, quota: ArtifactQuota): Promise<ArtifactUsage[]> {
  const usage: ArtifactUsage[] = [];
  for (const total of quota.totals)
    usage.push({
      total,
      usedBytes: await t.artifactBytes(
        total.environmentId === undefined ? undefined : { environmentId: total.environmentId },
      ),
    });
  return usage;
}

/** The total with the least room left, and that room (none left: zero or less). */
export function tightest(usage: readonly ArtifactUsage[]): ArtifactUsage & { readonly roomBytes: number } {
  let best = usage[0]!;
  for (const entry of usage)
    if (entry.total.limitBytes - entry.usedBytes < best.total.limitBytes - best.usedBytes) best = entry;
  return { ...best, roomBytes: best.total.limitBytes - best.usedBytes };
}

/** Whose artifacts a total counts: `The Tenant's artifacts`, or `Environment <id>'s artifacts`. */
export function totalSubject(total: ArtifactTotal): string {
  return total.environmentId === undefined ? "The Tenant's artifacts" : `Environment ${total.environmentId}'s artifacts`;
}

/** The Environment a session's artifacts belong to, if it names one. */
export async function environmentOfSession(t: Tx, sessionId: string | null): Promise<string | undefined> {
  if (sessionId === null) return undefined;
  return (await t.get<{ environmentId?: string }>("sessions", sessionId))?.environmentId;
}
