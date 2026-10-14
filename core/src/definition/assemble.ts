import type { DefinitionPart } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { AgentManifest, AgentRequirements, RuntimeManifest } from "../types/manifest.js";
import type { BuildDiagnostic, JsonObject } from "../types/shared.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindAgent } from "./bind-agent.js";
import { createManifest, RUNTIME_PART_ID } from "./manifest.js";
import { DELEGATE_NAME_PATTERN, delegateOf, delegatesOf } from "./delegate.js";
import { isRuntimeToolName } from "../utils/runtime-tools.js";

type BuildResult<Agent> =
  | {
      readonly ok: true;
      readonly agent: Agent;
      readonly manifest: AgentManifest;
    }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {}
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  parts: readonly DefinitionPart[],
  identity: Readonly<{
    id: string;
    name?: string;
    description?: string;
    metadata?: JsonObject;
    outputSchema?: ToolSchemaSource;
    requires?: AgentRequirements;
    /** A pinned manifest's `runtime` block, kept as it was (`agentFrom`). */
    runtime?: RuntimeManifest;
  }>
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  if (typeof identity.id !== "string" || identity.id.length === 0) {
    diagnostics.push(
      diagnostic("agent.invalid-id", "Agent id must be a non-empty string")
    );
  }
  if (
    identity.name !== undefined &&
    (typeof identity.name !== "string" || identity.name.length === 0)
  ) {
    diagnostics.push(
      diagnostic("agent.invalid-name", "Agent name must be a non-empty string")
    );
  }

  const partIds = new Set<string>();
  const frozen: DefinitionPart[] = [];
  for (const item of parts) {
    if (!item.id) diagnostics.push(diagnostic("part.invalid-id", "A part's id must not be empty"));
    else if (partIds.has(item.id))
      diagnostics.push(diagnostic("part.duplicate-id", `'${item.id}' is added twice`));
    else {
      partIds.add(item.id);
      frozen.push(Object.freeze({ ...item }));
    }
  }

  // The wire schema rejects a tool name used twice; report it at build time.
  const toolNames = new Set<string>();
  for (const item of frozen)
    for (const entry of item.tools ?? []) {
      if (toolNames.has(entry.name))
        diagnostics.push(
          diagnostic("tool.duplicate-name", `Tool '${entry.name}' is declared twice`, {
            toolName: entry.name,
          })
        );
      toolNames.add(entry.name);
      if (item.id !== RUNTIME_PART_ID && isRuntimeToolName(entry.name))
        diagnostics.push(
          diagnostic(
            "tool.reserved-name",
            `Tool '${entry.name}' takes the name of a tool the Runtime serves; rename it`,
            { toolName: entry.name }
          )
        );
      if (item.id !== RUNTIME_PART_ID && entry.name.includes("__"))
        diagnostics.push(
          diagnostic(
            "tool.invalid-name",
            `Tool '${entry.name}' must not contain '__', which names an MCP server's tools`,
            { toolName: entry.name }
          )
        );
    }
  diagnostics.push(...nameDiagnostics(frozen, "skills", "skill.duplicate-name", "skill"));
  diagnostics.push(...nameDiagnostics(frozen, "mcpServers", "mcp.duplicate-server", "MCP server"));
  diagnostics.push(...delegationDiagnostics(frozen));
  diagnostics.push(...sandboxDiagnostics(frozen));

  if (diagnostics.length)
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze(diagnostics),
    });
  const frozenParts = Object.freeze(frozen);
  const manifest = createManifest({
    id: identity.id,
    name: identity.name,
    description: identity.description,
    metadata: identity.metadata,
    outputSchema: identity.outputSchema,
    requires: identity.requires,
    runtime: identity.runtime,
    parts: frozenParts,
  });
  const agent = bindAgent(frozenParts, manifest, identity);
  return Object.freeze({ ok: true, agent, manifest });
}

/** A skill or MCP server name declared by two parts (two plugins, or a plugin and the agent). */
function nameDiagnostics(
  parts: readonly DefinitionPart[],
  field: "skills" | "mcpServers",
  code: string,
  what: string
): BuildDiagnostic[] {
  const found: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  for (const part of parts)
    for (const [key, value] of Object.entries(part[field] ?? {})) {
      if (key !== value.name || seen.has(value.name))
        found.push(diagnostic(code, `Duplicate ${what} '${value.name}'`));
      seen.add(value.name);
    }
  return found;
}

/** v1 delegation is one level deep and non-interactive; anything else fails the build by name. */
function delegationDiagnostics(items: readonly DefinitionPart[]): BuildDiagnostic[] {
  const found: BuildDiagnostic[] = [];
  for (const item of items)
    for (const tool of item.tools ?? []) {
      const delegate = delegateOf(tool);
      if (!delegate) continue;
      const child = delegate.manifest;
      const extra = { toolName: tool.name };
      if (!DELEGATE_NAME_PATTERN.test(child.id))
        found.push(
          diagnostic(
            "delegation.invalid-name",
            `Agent '${child.id}' is used as a tool, so its id must be 1-64 letters, digits, '_' or '-'`,
            extra
          )
        );
      if (!child.description?.trim())
        found.push(
          diagnostic(
            "delegation.description-required",
            `Agent '${child.id}' is used as a tool and needs a description: the parent's model reads it to decide when to delegate`,
            extra
          )
        );
      // A flow agent runs in its own linked session; its agents may delegate in turn.
      if ((child as { kind?: unknown }).kind === "workflow") continue;
      const nested = delegatesOf(child as AgentManifest)[0];
      if (nested)
        found.push(
          diagnostic(
            "delegation.nested",
            `'${child.id}' delegates to '${nested.manifest.id}'; nested delegation is not supported yet`,
            extra
          )
        );
      for (const childTool of delegate.agent?.getBinding().tools ?? [])
        if (childTool.approval)
          found.push(
            diagnostic(
              "delegation.approval-unsupported",
              `'${childTool.name}' in '${child.id}' needs approval; agents used as tools can't ask for it yet, so keep it on the parent`,
              extra
            )
          );
    }
  return found;
}

/**
 * Definitions declare no sandbox: a session gets one when it is opened (Sandboxes v3), and the
 * Runtime pins it in the manifest's `runtime` block. A part that still carries `sandbox` fails the
 * build instead of being silently dropped.
 */
function sandboxDiagnostics(items: readonly DefinitionPart[]): BuildDiagnostic[] {
  return items
    .filter((item) => item.sandbox !== undefined)
    .map(() =>
      diagnostic(
        "sandbox.in-definition",
        "Agents no longer declare a sandbox: open the session with it instead, createSession({ sandbox: { image, network: { allow }, resources } }), or set the Tenant's default sandbox."
      )
    );
}
