/**
 * What Studio's new-session picker makes of a credential coverage (`POST
 * /v1/tenant/credential-coverage { agentId, environmentId }`): how each entry reads, and which
 * Environments a Studio session may name. No React here, so `node --test` covers it.
 */
import type { ManagementClient } from "@nylorun/admin/client";
import type { EnvironmentView } from "@nylorun/agents";

export type Coverage = Awaited<ReturnType<ManagementClient["coverage"]>>;
export type CoverageEntry = Coverage["entries"][number];

/** How an entry reads: fine, a warning (an MCP server called without a credential), or a failure. */
export function coverageTone(entry: CoverageEntry): "ok" | "warn" | "error" {
  if (entry.status === "covered") return "ok";
  return entry.required ? "error" : "warn";
}

/** A short status label. */
export function coverageStatusLabel(entry: CoverageEntry): string {
  if (entry.status === "covered") return "Covered";
  return entry.required ? "Missing" : "No credential";
}

/** What an entry is: `MCP server tickets`, `HTTP tool refund_order · researcher`. */
export function coverageEntryLabel(entry: CoverageEntry): string {
  const what = entry.kind === "mcp" ? "MCP server" : entry.stage ? "HTTP stage" : "HTTP tool";
  return `${what} ${entry.name}${entry.agentId ? ` · ${entry.agentId}` : ""}`;
}

/** How many entries are covered, would go out without a credential, and would fail. */
export function coverageCounts(coverage: Coverage): { covered: number; warn: number; error: number } {
  const counts = { covered: 0, warn: 0, error: 0 };
  for (const entry of coverage.entries) {
    const tone = coverageTone(entry);
    if (tone === "ok") counts.covered += 1;
    else counts[tone] += 1;
  }
  return counts;
}

/** The secret an entry would send, as `name` (and its gateway), when it is covered. */
export function coverageCredentialLabel(entry: CoverageEntry): string | undefined {
  const credential = entry.credential;
  if (entry.status !== "covered" || !credential) return undefined;
  return credential.via ? `${credential.name} via ${credential.via}` : credential.name;
}

/**
 * Why a Studio session may not name this Environment, or undefined when it may: its owner guard
 * names another owner than Studio's (the Runtime would refuse the session with
 * `environment_owner_mismatch`).
 */
export function environmentUnavailable(
  environment: Pick<EnvironmentView, "ownerUserId">,
  owner: string,
): string | undefined {
  return environment.ownerUserId !== null && environment.ownerUserId !== owner
    ? `Only ${environment.ownerUserId}'s sessions may use it`
    : undefined;
}
