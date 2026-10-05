/**
 * Manifest fields that manifest v5 removed, and what replaces each. Manifest v5 is the first
 * where the Runtime never calls the developer's code during a session (see MIGRATION.md).
 */
export const REMOVED_CAPABILITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  hooks:
    "hooks were removed: the Runtime no longer calls your code during a session. Use an HTTP tool, approval on a tool, or a loop verifier instead (see MIGRATION.md)",
  beforeModelCall: "beforeModelCall was removed with hooks (see MIGRATION.md)",
  afterModelCall: "afterModelCall was removed with hooks (see MIGRATION.md)",
});

/** Why a manifest with this `manifestSchemaVersion` is refused, or undefined for version 5. */
export function manifestVersionIssue(version: unknown): string | undefined {
  if (version === 5) return undefined;
  if (version === 4 || version === 3)
    return `manifestSchemaVersion ${version} is no longer supported: manifest v5 removed hooks. Rebuild the agent with the current SDK (see MIGRATION.md)`;
  return `Unsupported manifestSchemaVersion ${String(version)}`;
}
