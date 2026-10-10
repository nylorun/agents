/**
 * What Studio's new-session picker makes of a credential coverage (`POST
 * /v1/tenant/credential-coverage`): which vaults to suggest, which servers need a credential
 * picked, and how each entry reads. No React here, so `node --test` covers it.
 */
import type { ManagementClient } from "@nylorun/admin/client";

export type Coverage = Awaited<ReturnType<ManagementClient["vaults"]["coverage"]>>;
export type CoverageEntry = Coverage["entries"][number];
export type CoverageCredential = CoverageEntry["matches"][number];

/** A credential picked for a server name, with the vault it is in. */
export interface PickedCredential {
  readonly serverName: string;
  readonly credentialId: string;
  readonly vaultId: string;
}

/**
 * The vaults to attach: those attached, then, for each URL no attached vault covers, the first
 * vault that holds a credential for it (a person's own before the installation's), unless one
 * already picked holds one.
 */
export function suggestedVaultIds(coverage: Coverage): string[] {
  const ids = new Set(coverage.vaultIds);
  for (const entry of coverage.entries) {
    if (entry.status !== "missing" || entry.available.length === 0) continue;
    if (entry.available.some((item) => ids.has(item.vaultId))) continue;
    ids.add(entry.available[0]!.vaultId);
  }
  return [...ids];
}

/**
 * The server names that need a credential picked: several attached credentials match their URL,
 * or the pick names none of them. Kept once picked, so the choice can change.
 */
export function credentialChoices(
  coverage: Coverage,
): { serverName: string; options: CoverageCredential[] }[] {
  const choices = new Map<string, Map<string, CoverageCredential>>();
  for (const entry of coverage.entries) {
    if (entry.matches.length < 2 && entry.status !== "selection_mismatch") continue;
    const options = choices.get(entry.serverName) ?? new Map<string, CoverageCredential>();
    for (const item of entry.matches) options.set(item.credentialId, item);
    choices.set(entry.serverName, options);
  }
  return [...choices].map(([serverName, options]) => ({ serverName, options: [...options.values()] }));
}

/** The picks whose vault is still attached: a pick outside the attached vaults is refused. */
export function keptPicks(
  picks: readonly PickedCredential[],
  vaultIds: readonly string[],
): PickedCredential[] {
  return picks.filter((item) => vaultIds.includes(item.vaultId));
}

/** `credentialSelections` for the Runtime: the picks without their vaults. */
export function selectionsOf(
  picks: readonly PickedCredential[],
): { serverName: string; credentialId: string }[] {
  return picks.map(({ serverName, credentialId }) => ({ serverName, credentialId }));
}

/** How an entry reads: fine, a warning (an MCP server called without a credential), or a failure. */
export function coverageTone(entry: CoverageEntry): "ok" | "warn" | "error" {
  if (entry.status === "covered") return "ok";
  if (entry.status === "missing" && !entry.required) return "warn";
  return "error";
}

/** A short status label. */
export function coverageStatusLabel(entry: CoverageEntry): string {
  switch (entry.status) {
    case "covered":
      return "Covered";
    case "missing":
      return entry.required ? "Missing" : "No credential";
    case "ambiguous":
      return "Pick one";
    case "selection_mismatch":
      return "Wrong pick";
  }
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

/** How many of the agent's URLs a vault holds a credential for, attached or not. */
export function vaultHolds(coverage: Coverage, vaultId: string): number {
  return coverage.entries.filter((entry) =>
    [...entry.matches, ...entry.available].some((item) => item.vaultId === vaultId),
  ).length;
}
