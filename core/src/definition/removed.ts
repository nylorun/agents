/** Why a part may not carry a field that manifest v5 removed. */
export const REMOVED_PART_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  hooks:
    "hooks were removed: the Runtime runs agents from their manifests alone. Use an HTTP tool, the Tenant's tool policy, or a loop verifier instead (see MIGRATION.md)",
  model: "An agent must not include model; the Runtime owns model resolution",
});

/** Manifest fields an older SDK wrote, and why each is refused. */
export const REMOVED_MANIFEST_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  schemaVersion: "Manifest field schemaVersion was renamed to manifestSchemaVersion",
  model: "Manifest must not include top-level model; Runtime owns model resolution",
  hooks:
    "hooks were removed: the Runtime runs agents from their manifests alone. Use an HTTP tool, the Tenant's tool policy, or a loop verifier instead (see MIGRATION.md)",
  capabilities:
    "Manifest v7 has no capabilities: the agent's instructions, tools, skills and mcpServers are top-level fields. Rebuild the agent with the current SDK (see MIGRATION.md)",
});

/** Why a manifest with this `manifestSchemaVersion` is refused, or undefined for version 7. */
export function manifestVersionIssue(version: unknown): string | undefined {
  if (version === 7) return undefined;
  if (typeof version === "number" && version >= 3 && version <= 6)
    return `manifestSchemaVersion ${version} is no longer supported: manifest v7 has no capabilities. Rebuild the agent with the current SDK (see MIGRATION.md)`;
  return `Unsupported manifestSchemaVersion ${String(version)}`;
}

/** Why a workflow manifest with this `workflowSchemaVersion` is refused, or undefined for version 3. */
export function workflowVersionIssue(version: unknown): string | undefined {
  if (version === 3) return undefined;
  if (version === 2 || version === 1)
    return `workflowSchemaVersion ${version} is no longer supported: flows run no code since manifest v5 (no input, on, verify or decide functions). Rebuild the flow with the current SDK (see MIGRATION.md)`;
  return `Unsupported workflowSchemaVersion ${String(version)}`;
}
