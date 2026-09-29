/**
 * The Tenant's access policy (Host feature `subject-tokens`): the roles subject tokens are
 * minted for, what a publishable key grants alone (`anon`), and how long tokens live. One
 * validated JSON document in the Tenant settings; a Tenant that never set one has no roles,
 * so nothing can be minted.
 *
 * A token's permissions are resolved from the policy on every request, so editing a role
 * changes outstanding tokens at their next request and removing one ends them.
 */
import {
  AccessPolicySchema,
  DEFAULT_ACCESS_POLICY,
  type AccessPolicy,
  type RoleLimits,
  type TokenScope,
} from "@nylorun/core/contracts";
import type { Tx } from "../store/types.js";

export const ACCESS_POLICY_SETTING = "access.policy";

export async function readPolicy(t: Tx): Promise<AccessPolicy> {
  const stored = await t.getSetting(ACCESS_POLICY_SETTING);
  if (stored === undefined) return DEFAULT_ACCESS_POLICY;
  // Only `writePolicy` stores it, after validation.
  return AccessPolicySchema.parse(JSON.parse(stored));
}

export async function writePolicy(t: Tx, policy: AccessPolicy): Promise<void> {
  await t.putSetting(
    ACCESS_POLICY_SETTING,
    JSON.stringify(AccessPolicySchema.parse(policy))
  );
}

/** What a token may do right now: its role narrowed by what the mint asked for. */
export interface EffectiveAccess {
  readonly role: string;
  readonly scopes: ReadonlySet<TokenScope>;
  readonly agents: ReadonlySet<string> | "*";
  readonly limits?: RoleLimits;
}

/** Agents both lists allow; `"*"` allows every agent. */
export function intersectAgents(
  a: readonly string[] | "*",
  b: readonly string[] | "*" | undefined
): ReadonlySet<string> | "*" {
  if (b === undefined || b === "*") return a === "*" ? "*" : new Set(a);
  if (a === "*") return new Set(b);
  const allowed = new Set(a);
  return new Set(b.filter((agent) => allowed.has(agent)));
}

/**
 * The role's permissions narrowed to `scopes` and `agents`, or undefined when the role no
 * longer exists.
 */
export function resolveRole(
  policy: AccessPolicy,
  role: string,
  scopes: readonly TokenScope[],
  agents?: readonly string[]
): EffectiveAccess | undefined {
  const entry = Object.hasOwn(policy.roles, role)
    ? policy.roles[role]
    : undefined;
  if (!entry) return undefined;
  const allowed = new Set(entry.scopes);
  return {
    role,
    scopes: new Set(scopes.filter((scope) => allowed.has(scope))),
    agents: intersectAgents(entry.agents, agents),
    ...(entry.limits ? { limits: entry.limits } : {}),
  };
}

/** True when `agentId` is allowed by `agents`. */
export function agentAllowed(
  agents: ReadonlySet<string> | "*",
  agentId: string
): boolean {
  return agents === "*" || agents.has(agentId);
}
