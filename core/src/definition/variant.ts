import type {
  AgentManifest,
  McpServerManifest,
  McpToolSettings,
  SkillManifest,
  ToolManifest,
} from "../types/manifest.js";
import { canonical } from "../utils/canonical.js";

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function toolsByName(
  tools: readonly ToolManifest[] | undefined
): Map<string, ToolManifest> {
  const map = new Map<string, ToolManifest>();
  for (const tool of tools ?? []) map.set(tool.name, tool);
  return map;
}

/** Candidate tools/skills/agents-as-tools may only be removed, never added or changed. */
function removeOnlyTools(
  pinned: readonly ToolManifest[] | undefined,
  candidate: readonly ToolManifest[] | undefined
): boolean {
  const base = toolsByName(pinned);
  for (const tool of candidate ?? []) {
    const prior = base.get(tool.name);
    if (!prior || !same(prior, tool)) return false;
  }
  return true;
}

function removeOnlySkills(
  pinned: Readonly<Record<string, SkillManifest>> | undefined,
  candidate: Readonly<Record<string, SkillManifest>> | undefined
): boolean {
  const base = pinned ?? {};
  for (const [name, skill] of Object.entries(candidate ?? {})) {
    const prior = base[name];
    if (!prior || !same(prior, skill)) return false;
  }
  return true;
}

/**
 * One tool setting, or the `"*"` entry, only tightened (R2b C9, Q18): `enabled` kept or set to
 * `false`, `approval` kept or set to `always`, `deferred` kept. Each level of a tool's resolution
 * (its entry, then `"*"`) either keeps its value or tightens it, so the tool does too.
 */
function tightensSettings(
  prior: McpToolSettings | undefined,
  next: McpToolSettings
): boolean {
  return (
    (next.enabled === prior?.enabled || next.enabled === false) &&
    (next.approval === prior?.approval || next.approval === "always") &&
    next.deferred === prior?.deferred
  );
}

/**
 * The servers of a turn variant: the pinned ones, the same but for their `tools` maps, where a
 * variant may only disable a tool or require its approval (R2b C9, Q18). An entry the pin has
 * stays, since dropping one could widen.
 */
function tightensServers(
  pinned: Readonly<Record<string, McpServerManifest>> | undefined,
  candidate: Readonly<Record<string, McpServerManifest>> | undefined
): boolean {
  if (pinned === undefined || candidate === undefined) return same(candidate, pinned);
  const names = Object.keys(pinned);
  if (!same(Object.keys(candidate).sort(), [...names].sort())) return false;
  return names.every((name) => {
    const { tools: priorTools, ...prior } = pinned[name]!;
    const { tools: nextTools, ...next } = candidate[name]!;
    if (!same(next, prior)) return false;
    if (nextTools === undefined) return priorTools === undefined;
    for (const key of Object.keys(priorTools ?? {})) if (!Object.hasOwn(nextTools, key)) return false;
    return Object.entries(nextTools).every(([key, settings]) =>
      tightensSettings(Object.hasOwn(priorTools ?? {}, key) ? priorTools![key] : undefined, settings)
    );
  });
}

/**
 * Whether `candidate` is a valid turn-manifest variant of the session's pinned
 * manifest (`loops.md` §3.4). Setup (MCP, sandbox) is fixed, but a variant may disable an MCP
 * server's tools or require their approval (R2b C9, Q18);
 * code-backed tools/skills/agents-as-tools are remove-only; plain data may change.
 */
export function isVariantOf(
  candidate: AgentManifest,
  pinned: AgentManifest
): boolean {
  if (candidate.id !== pinned.id) return false;
  // A variant of a v5 pin may be v6, to set an MCP server's tools; never older than its pin.
  if (candidate.manifestSchemaVersion < pinned.manifestSchemaVersion)
    return false;
  if (!same(candidate.runtime ?? {}, pinned.runtime ?? {})) return false;

  const pinnedById = new Map(
    pinned.capabilities.map((capability) => [capability.id, capability])
  );
  const candidateById = new Map(
    candidate.capabilities.map((capability) => [capability.id, capability])
  );

  for (const [, prior] of pinnedById) {
    const next = candidateById.get(prior.id);
    // Setup — and any capability that declares it — must not change or be removed.
    if (prior.mcpServers !== undefined) {
      if (!next || !tightensServers(prior.mcpServers, next.mcpServers)) return false;
    }
    if (prior.sandbox !== undefined) {
      if (!next || !same(next.sandbox, prior.sandbox)) return false;
    }
  }

  for (const [id, next] of candidateById) {
    const prior = pinnedById.get(id);
    if (!prior) return false; // cannot add capabilities
    if (next.type !== prior.type) return false;
    if (!removeOnlyTools(prior.tools, next.tools)) return false;
    if (!removeOnlySkills(prior.skills, next.skills)) return false;
    // Free: name, description, metadata, instructions (and model once it exists).
    if (!tightensServers(prior.mcpServers, next.mcpServers)) return false;
    if (!same(next.sandbox, prior.sandbox)) return false;
  }

  // Dropping a capability is allowed only when it had no MCP / sandbox
  // (those are enforced above). Tools and skills on a dropped capability are
  // removals, which §3.4 permits.
  return true;
}
