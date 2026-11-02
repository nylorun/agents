import { runtimeToolOf } from "../plugins/index.js";
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

/** An agent used as a tool that runs in the turn (not a flow agent, which runs in its own session). */
function loopAgentOf(tool: ToolManifest): AgentManifest | undefined {
  return tool.agent && !("kind" in tool.agent) ? tool.agent : undefined;
}

/**
 * Candidate tools (agents used as tools included) may only be removed, never added or changed,
 * except that an agent used as a tool may be narrowed (`narrows`): its own tools removed and its
 * MCP servers' tools disabled, the rest of it the same.
 */
function removeOnlyTools(
  pinned: readonly ToolManifest[] | undefined,
  candidate: readonly ToolManifest[] | undefined
): boolean {
  const base = toolsByName(pinned);
  for (const tool of candidate ?? []) {
    const prior = base.get(tool.name);
    if (!prior) return false;
    if (same(prior, tool)) continue;
    const child = loopAgentOf(tool);
    const priorChild = loopAgentOf(prior);
    const { agent: _agent, ...rest } = tool;
    const { agent: _prior, ...priorRest } = prior;
    if (!child || !priorChild || !same(rest, priorRest) || !narrows(child, priorChild)) return false;
  }
  return true;
}

/** `candidate` is `prior` with tools removed and MCP tools disabled, and nothing else changed. */
function narrows(candidate: AgentManifest, prior: AgentManifest): boolean {
  const { tools, mcpServers, ...rest } = candidate;
  const { tools: priorTools, mcpServers: priorServers, ...priorRest } = prior;
  return same(rest, priorRest) && removeOnlyTools(priorTools, tools) && tightensServers(priorServers, mcpServers);
}

/**
 * One tool setting, or the `"*"` entry, only tightened: `enabled` kept or set to
 * `false`, `approval` and `deferred` kept. Each level of a tool's resolution (its entry, then
 * `"*"`) either keeps its value or tightens it, so the tool does too. A variant adds no
 * approval: tool approvals are the Tenant's tool policy.
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
 * variant may only disable a tool. An entry the pin has
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
 * tighten its MCP servers' tool settings, and change its instructions, name,
 * description and metadata. An agent it uses as a tool may only be narrowed the same way: its
 * tools removed and its MCP servers' tool settings tightened (what `withoutTools` makes). Its skills and servers are setup: the sandbox holds the skills from
 * the session's start.
 */
export function isVariantOf(
  candidate: AgentManifest,
  pinned: AgentManifest
): boolean {
  if (candidate.id !== pinned.id) return false;
  if (candidate.manifestSchemaVersion !== pinned.manifestSchemaVersion) return false;
  if (!same(candidate.outputSchema, pinned.outputSchema)) return false;
  // What the agent needs of its Environment was checked when the session opened (D65).
  if (!same(candidate.requires, pinned.requires)) return false;
  if (!removeOnlyTools(pinned.tools, candidate.tools)) return false;
  if (!same(candidate.skills, pinned.skills)) return false;
  return tightensServers(pinned.mcpServers, candidate.mcpServers);
}

/**
 * `manifest` without the tools `names` names (a message's `removeTools`): a turn variant of it
 * (`isVariantOf`) that the Runtime makes, so a client names what a turn may not use without
 * sending a whole manifest. In the root agent and in each agent it uses as a tool, a name removes:
 *
 * - the tool of that name: an agent used as a tool, an HTTP tool, any declared tool;
 * - `<server>__<tool>`, an MCP server's tool by the server's name and the tool's own name on it:
 *   disabled in the server's `tools` settings (`{enabled: false}`);
 * - `<server>`, an MCP server's name: every tool of it disabled (`"*"` and each entry).
 *
 * A name that matches nothing is ignored: the version the turn runs may not have it. Returns
 * `manifest` itself when nothing matched.
 */
export function withoutTools(manifest: AgentManifest, names: readonly string[]): AgentManifest {
  const removed = new Set(names);
  if (removed.size === 0) return manifest;
  const next = narrowAgent(manifest, removed, true);
  return same(next, manifest) ? manifest : next;
}

function narrowAgent(agent: AgentManifest, removed: ReadonlySet<string>, root: boolean): AgentManifest {
  const { tools: _tools, mcpServers: _servers, engine: _engine, ...rest } = agent;
  // A Runtime plugin's tool by the name the model reads (ADR-106): `nylorun__ask` turns `ask` off.
  const offPlugin = new Set([...removed].flatMap((name) => runtimeToolOf(name) ?? []));
  const engine =
    agent.engine?.plugins !== undefined && offPlugin.size > 0
      ? { ...agent.engine, plugins: agent.engine.plugins.map((plugin) => ({ ...plugin, tools: plugin.tools.filter((tool) => !offPlugin.has(tool)) })) }
      : agent.engine;
  const tools = agent.tools
    ?.filter((tool) => !removed.has(tool.name))
    .map((tool) => {
      const child = root ? loopAgentOf(tool) : undefined;
      return child ? { ...tool, agent: narrowAgent(child, removed, false) } : tool;
    });
  const servers =
    agent.mcpServers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(agent.mcpServers).map(([key, server]) => [key, narrowServer(server, removed)])
        );
  return {
    ...rest,
    ...(tools === undefined ? {} : { tools }),
    ...(servers === undefined ? {} : { mcpServers: servers }),
    ...(engine === undefined ? {} : { engine }),
  };
}

function narrowServer(server: McpServerManifest, removed: ReadonlySet<string>): McpServerManifest {
  const prefix = `${server.name}__`;
  const all = removed.has(server.name);
  const named = [...removed].filter((name) => name.startsWith(prefix) && name.length > prefix.length);
  if (!all && named.length === 0) return server;
  const tools: Record<string, McpToolSettings> = { ...(server.tools ?? {}) };
  const disable = (key: string) => {
    tools[key] = { ...(Object.hasOwn(tools, key) ? tools[key] : {}), enabled: false };
  };
  if (all) for (const key of [...Object.keys(tools), "*"]) disable(key);
  else for (const name of named) disable(name.slice(prefix.length));
  return { ...server, tools };
}
