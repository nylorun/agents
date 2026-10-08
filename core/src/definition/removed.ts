/**
 * Capability fields that manifest v5 removed, and what replaces each. Manifest v5 (with workflow
 * manifest v3 for flow agents) is the first where the Runtime never calls the developer's code
 * during a session (see MIGRATION.md). `model` went earlier: the Runtime owns the model.
 */
export const REMOVED_CAPABILITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  hooks:
    "hooks were removed: the Runtime no longer calls your code during a session. Use an HTTP tool, approval on a tool, or a loop verifier instead (see MIGRATION.md)",
  beforeModelCall: "beforeModelCall was removed with hooks (see MIGRATION.md)",
  afterModelCall: "afterModelCall was removed with hooks (see MIGRATION.md)",
  model: "A capability must not include model; the Runtime owns model resolution",
});

/** Manifest fields an older SDK wrote, and why each is refused. */
export const REMOVED_MANIFEST_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  schemaVersion: "Manifest field schemaVersion was renamed to manifestSchemaVersion",
  model: "Manifest must not include top-level model; Runtime owns model resolution",
});

/**
 * Why a manifest with this `manifestSchemaVersion` is refused, or undefined for version 5 and
 * version 6 (R2b C9: an MCP server's `tools` and `deferred`; v5 is accepted unchanged).
 */
export function manifestVersionIssue(version: unknown): string | undefined {
  if (version === 5 || version === 6) return undefined;
  if (version === 4 || version === 3)
    return `manifestSchemaVersion ${version} is no longer supported: manifest v5 removed hooks. Rebuild the agent with the current SDK (see MIGRATION.md)`;
  return `Unsupported manifestSchemaVersion ${String(version)}`;
}

/** Why a workflow manifest with this `workflowSchemaVersion` is refused, or undefined for version 3. */
export function workflowVersionIssue(version: unknown): string | undefined {
  if (version === 3) return undefined;
  if (version === 2 || version === 1)
    return `workflowSchemaVersion ${version} is no longer supported: flows run no code since manifest v5 (no input, on, verify or decide functions). Rebuild the flow with the current SDK (see MIGRATION.md)`;
  return `Unsupported workflowSchemaVersion ${String(version)}`;
}
