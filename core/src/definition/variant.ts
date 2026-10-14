import type {
  AgentManifest,
  McpServerManifest,
  McpToolSettings,
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

/** Candidate tools (agents used as tools included) may only be removed, never added or changed. */
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

/**
 * One tool setting, or the `"*"` entry, only tightened (R2b C9, Q18): `enabled` kept or set to
 * `false`, `approval` and `deferred` kept. Each level of a tool's resolution (its entry, then
 * `"*"`) either keeps its value or tightens it, so the tool does too. A variant adds no
 * approval: tool approvals are the Tenant's tool policy (R5 step 2).
 */
function tightensSettings(
  prior: McpToolSettings | undefined,
  next: McpToolSettings
): boolean {
  return (
    (next.enabled === prior?.enabled || next.enabled === false) &&
    next.approval === prior?.approval &&
    next.deferred === prior?.deferred
  );
}

/**
 * The servers of a turn variant: the pinned ones, the same but for their `tools` maps, where a
 * variant may only disable a tool (R2b C9, Q18). An entry the pin has
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
 * Whether `candidate` is a valid turn-manifest variant of the session's pinned manifest
 * (`loops.md` §3.4). A variant may remove tools (agents used as tools and HTTP tools included),
 * tighten its MCP servers' tool settings (R2b C9, Q18), and change its instructions, name,
 * description and metadata. Its skills and servers are setup: the sandbox holds the skills from
 * the session's start. It never sets `runtime`; the turn runs with the pin's.
 */
export function isVariantOf(
  candidate: AgentManifest,
  pinned: AgentManifest
): boolean {
  if (candidate.id !== pinned.id) return false;
  if (candidate.manifestSchemaVersion !== pinned.manifestSchemaVersion) return false;
  if (candidate.runtime !== undefined) return false;
  if (!same(candidate.outputSchema, pinned.outputSchema)) return false;
  // What the agent needs of its Environment was checked when the session opened (D65).
  if (!same(candidate.requires, pinned.requires)) return false;
  if (!removeOnlyTools(pinned.tools, candidate.tools)) return false;
  if (!same(candidate.skills, pinned.skills)) return false;
  return tightensServers(pinned.mcpServers, candidate.mcpServers);
}
