/**
 * The session's MCP tools as our engine offers them (protocol 15). The Runtime states what the
 * session's MCP servers listed (`turn.start.mcp`: raw names and schemas, and whether the turn
 * leaves each tool `enabled`); our engine names each tool for the model, decides which to defer,
 * and makes each call an effect of the tool's identity (`target: {kind: "mcp", server, tool}`).
 *
 * - **Names** (R2b C6): `server__tool`, each character outside `[A-Za-z0-9_-]` replaced by `_`,
 *   since MCP allows `.` and 128 characters and OpenAI, Bedrock and Gemini on Vertex do not. A
 *   name over `MODEL_TOOL_NAME_MAX` (64), or a renamed one that collides, keeps 55 characters and
 *   adds `_` and 8 hex characters of the SHA-256 of the raw `server/tool`. A name the agent's own
 *   tools or an earlier tool already took leaves the tool out.
 * - **Deferral** (R2b C10): a tool the manifest defers, or, when the manifest says nothing, every
 *   tool of an agent whose listed MCP tools would pass a share of the model's context window
 *   (`McpToolConfig`), leaves the model's list; the model finds it with `tool_search` and runs it
 *   with `tool_call`. An agent that declares its engine features (ADR-100) without
 *   `toolSearch: true` is never deferred automatically: past the share it keeps its tools, and
 *   the set says so (`diagnostics`).
 * - **The layout is pinned** (`McpLayout`, in our engine's state): decided the first time the
 *   session's facts are seen and kept while they stay the same, so every model call of the
 *   session lists the same tools.
 *
 * A tool the turn disables, or whose input schema our engine cannot use, is left out.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { delegatesOf, MODEL_TOOL_NAME_MAX } from "../definition/delegate.js";
import { schemaFromJSON } from "../definition/schema-json.js";
import type { AgentManifest } from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { McpFacts } from "../harness-api/mcp.js";
import type { ModelDescriptor } from "../harness-api/messages.js";
import { TOOL_CALL_TOOL, TOOL_SEARCH_TOOL, deferredToolsTools, type EngineTool } from "./tools.js";
import { TOOL_SEARCH_TEXT } from "./blocks.js";
import { declaresEngine } from "./features.js";

export { MODEL_TOOL_NAME_MAX };
/** The hex characters of the hash a shortened or colliding tool name ends with. */
const NAME_HASH_CHARS = 8;

/** The harness's configuration of the MCP tools our engine offers. */
export interface McpToolConfig {
  /**
   * The share of the model's context window past which an agent's MCP tools are deferred, when
   * the manifest does not say (Q21). Default 0.1.
   */
  readonly deferShare: number;
  /** Characters per token, to estimate what tool definitions take of a context window. Default 4. */
  readonly charsPerToken: number;
  /**
   * The context window, in tokens, assumed when the turn names no model (`turn.start.model`).
   * Default 32,768, small, as for a custom endpoint.
   */
  readonly fallbackContextWindow: number;
  /** How much of a server's own instructions the deferred tools' note shows. Default 2,000. */
  readonly serverInstructionsMaxChars: number;
  /** How many tools `tool_search` returns when the model sets no `limit`. Default 8. */
  readonly toolSearchDefaultLimit: number;
  /** The most tools one `tool_search` returns. Default 20. */
  readonly toolSearchMaxLimit: number;
}

export const DEFAULT_MCP_TOOL_CONFIG: McpToolConfig = Object.freeze({
  deferShare: 0.1,
  charsPerToken: 4,
  fallbackContextWindow: 32_768,
  serverInstructionsMaxChars: 2_000,
  toolSearchDefaultLimit: 8,
  toolSearchMaxLimit: 20,
});

/** `set` over the defaults. */
export function mcpToolConfigOf(set?: Partial<McpToolConfig>): McpToolConfig {
  return Object.freeze({
    ...DEFAULT_MCP_TOOL_CONFIG,
    ...Object.fromEntries(Object.entries(set ?? {}).filter(([, value]) => value !== undefined)),
  });
}

const hexOf = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * The name the model knows an MCP tool by (R2b C6, Q13): `server__tool` with each character
 * outside `[A-Za-z0-9_-]` replaced by `_`. A name over 64 characters, or one that collides
 * (`suffixed`), keeps 55 and adds `_` and 8 hex characters of the SHA-256 of the raw
 * `server/tool`.
 */
export function mcpToolName(server: string, tool: string, options: { readonly suffixed?: boolean } = {}): string {
  const name = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (name.length <= MODEL_TOOL_NAME_MAX && !options.suffixed) return name;
  // Part of the names pinned sessions' tools already have (protocol 15's naming), so a constant.
  const hash = hexOf(`${server}/${tool}`).slice(0, NAME_HASH_CHARS);
  return `${name.slice(0, MODEL_TOOL_NAME_MAX - NAME_HASH_CHARS - 1)}_${hash}`;
}

/** A tool whose model-facing name is not `server__tool`. */
export interface McpRenamedTool {
  readonly serverToolName: string;
  readonly name: string;
}

/**
 * The model-facing names of a server's tools (`tools`, raw names, in the server's order), and
 * those it renamed or left out. Names that need no change go first, so a renamed tool never takes
 * the name of another of the server's tools; a renamed one that collides gets the hash suffix;
 * a name `taken` holds (the agent's own tools, an earlier server's tools) leaves the tool out.
 * Adds the names it gives to `taken`.
 */
export function mcpToolNames(
  server: string,
  tools: readonly string[],
  taken: Set<string>,
): { names: Map<string, string>; renamed: McpRenamedTool[]; omitted: string[] } {
  const names = new Map<string, string>();
  const renamed: McpRenamedTool[] = [];
  const omitted: string[] = [];
  for (const tool of tools) {
    const name = mcpToolName(server, tool);
    if (name !== `${server}__${tool}`) continue;
    if (taken.has(name)) omitted.push(name);
    else {
      taken.add(name);
      names.set(tool, name);
    }
  }
  for (const tool of tools) {
    let name = mcpToolName(server, tool);
    if (name === `${server}__${tool}`) continue;
    if (taken.has(name)) name = mcpToolName(server, tool, { suffixed: true });
    if (taken.has(name)) {
      omitted.push(name);
      continue;
    }
    taken.add(name);
    names.set(tool, name);
    renamed.push({ serverToolName: tool, name });
  }
  return { names, renamed, omitted };
}

/**
 * The deferral our engine decided for a session's MCP tools (R2b C10): the identities of the
 * deferred ones (`mcpToolKey`), for the facts whose hash is `factsHash`. Kept in our engine's
 * state, so the session keeps it while its facts stay the same.
 */
export interface McpLayout {
  readonly factsHash: string;
  readonly deferred: readonly string[];
}

/** The key of an MCP tool's identity in a layout: its agent, server and own name. */
export function mcpToolKey(agentId: string | undefined, server: string, tool: string): string {
  return JSON.stringify([agentId ?? null, server, tool]);
}

/** A server some of whose tools are deferred, as the model's note names it. */
export interface DeferredServerNote {
  readonly serverName: string;
  /** How many of its tools are deferred. */
  readonly tools: number;
  /** The server's own instructions (MCP `initialize`), if it gave any. */
  readonly instructions?: string;
}

/**
 * The note the model reads beside `tool_search` (block `tool_search`): each server with deferred
 * tools, how many, and its own instructions cut to `config.serverInstructionsMaxChars`. `wording`
 * replaces the sentence before the servers (`engine.instructions.tool_search`).
 */
export function deferredToolsNote(
  servers: readonly DeferredServerNote[],
  config: Pick<McpToolConfig, "serverInstructionsMaxChars">,
  wording: string = TOOL_SEARCH_TEXT,
): string {
  const max = config.serverInstructionsMaxChars;
  const lines = servers.map((server) => {
    const head = `- ${server.serverName}: ${server.tools} tool${server.tools === 1 ? "" : "s"}`;
    const text = server.instructions?.trim();
    if (!text) return head;
    const cut = text.length > max ? `${text.slice(0, max)}…` : text;
    return `${head}. The server says: ${cut}`;
  });
  return [wording, ...lines].join("\n");
}

/** Something about the session's MCP tools our engine says instead of choosing (ADR-100). */
export interface McpToolDiagnostic {
  readonly code: "mcp_tools_inline";
  readonly message: string;
  /** The agent used as a tool it is about; absent for the root agent. */
  readonly agentId?: string;
}

/** The session's MCP tools as our engine offers them, for one run. */
export interface McpToolSet {
  /**
   * Every agent's MCP tools in the model's order: the listed ones, then for each agent with
   * deferred tools `tool_search` (with the note on its servers), `tool_call` and the deferred
   * ones (`deferred: true`). An agent used as a tool's carry its `agentId`.
   */
  readonly tools: readonly EngineTool[];
  /** The layout these tools follow: the one given, or the one decided now. */
  readonly layout: McpLayout;
  /** The deferred tools of an agent (`agentId` absent for the root), which `tool_search` searches. */
  deferredOf(agentId: string | undefined): readonly EngineTool[];
  /**
   * When the layout was decided now: each agent that declares no `engine.toolSearch` and whose
   * listed MCP tools pass the deferral threshold, so they all stay in its list.
   */
  readonly diagnostics: readonly McpToolDiagnostic[];
}

/**
 * The session's MCP tools from the turn's facts (`turn.start.mcp`) for the agent tree `manifest`.
 * `layout` is the one our engine's state keeps: followed while its `factsHash` matches, else the
 * deferral is decided again from the model's window (`model.contextWindow`, or
 * `config.fallbackContextWindow`). `taken(agent)` names an agent's other tools (our engine's
 * own), which an MCP tool's name may not take besides the agent's declared tools.
 */
export function mcpToolSet(
  facts: McpFacts | undefined,
  manifest: AgentManifest,
  options: {
    readonly config: McpToolConfig;
    readonly model?: Pick<ModelDescriptor, "contextWindow">;
    readonly layout?: McpLayout;
    readonly taken?: (agent: AgentManifest) => readonly string[];
  },
): McpToolSet {
  const { config } = options;
  const factsHash = hexOf(JSON.stringify(facts ?? { servers: [] }));
  const agents = new Map<string | undefined, AgentManifest>([
    [undefined, manifest],
    ...delegatesOf(manifest).map(({ manifest: child }) => [child.id, child] as const),
  ]);
  const named: Named[] = [];
  const takenOf = new Map<string | undefined, Set<string>>();
  for (const server of facts?.servers ?? []) {
    const agent = agents.get(server.agentId);
    if (!agent) continue;
    let taken = takenOf.get(server.agentId);
    if (!taken) {
      taken = new Set([
        ...(agent.tools ?? []).map((tool) => tool.name),
        ...(options.taken?.(agent) ?? []),
        TOOL_SEARCH_TOOL,
        TOOL_CALL_TOOL,
      ]);
      takenOf.set(server.agentId, taken);
    }
    const usable = server.tools.flatMap((tool) => {
      if (!tool.enabled) return [];
      const inputSchema = usableSchema(tool.inputSchema);
      return inputSchema ? [{ fact: tool, inputSchema }] : [];
    });
    const { names } = mcpToolNames(
      server.name,
      usable.map((item) => item.fact.name),
      taken,
    );
    for (const { fact, inputSchema } of usable) {
      const name = names.get(fact.name);
      if (name === undefined) continue;
      const outputSchema = fact.outputSchema ? usableSchema(fact.outputSchema) : undefined;
      named.push({
        agentId: server.agentId,
        server: server.name,
        key: mcpToolKey(server.agentId, server.name, fact.name),
        setting: fact.deferred,
        tool: {
          ...(server.agentId === undefined ? {} : { agentId: server.agentId }),
          name,
          ...(fact.description === undefined || fact.description.length === 0 ? {} : { description: fact.description }),
          inputSchema,
          ...(outputSchema === undefined ? {} : { outputSchema }),
          target: { kind: "mcp", server: server.name, tool: fact.name },
        },
      });
    }
  }
  const searches = (agentId: string | undefined) => {
    const engine = agents.get(agentId)?.engine;
    return !declaresEngine(engine) || engine?.toolSearch === true;
  };
  const reused = options.layout !== undefined && options.layout.factsHash === factsHash;
  const decided = reused ? undefined : decideDeferral(named, options.model, config, searches);
  const layout = reused ? options.layout! : { factsHash, deferred: decided!.deferred };
  const deferredKeys = new Set(layout.deferred);
  const inline: EngineTool[] = [];
  const deferred = new Map<string | undefined, EngineTool[]>();
  const notes = new Map<string | undefined, Map<string, number>>();
  for (const item of named) {
    if (!deferredKeys.has(item.key)) {
      inline.push(item.tool);
      continue;
    }
    deferred.set(item.agentId, [...(deferred.get(item.agentId) ?? []), { ...item.tool, deferred: true }]);
    const servers = notes.get(item.agentId) ?? new Map<string, number>();
    servers.set(item.server, (servers.get(item.server) ?? 0) + 1);
    notes.set(item.agentId, servers);
  }
  const session: EngineTool[] = [];
  for (const [agentId, tools] of deferred) {
    const servers: DeferredServerNote[] = [...notes.get(agentId)!].map(([serverName, count]) => {
      const instructions = facts?.servers.find((item) => item.agentId === agentId && item.name === serverName)?.instructions;
      return { serverName, tools: count, ...(instructions ? { instructions } : {}) };
    });
    const [search, call] = deferredToolsTools(config);
    const wording = agents.get(agentId)?.engine?.instructions?.tool_search;
    for (const tool of [{ ...search!, instructions: [deferredToolsNote(servers, config, wording)] }, call!])
      session.push({ ...(agentId === undefined ? {} : { agentId }), ...tool });
    session.push(...tools);
  }
  return {
    tools: [...inline, ...session],
    layout,
    deferredOf: (agentId) => deferred.get(agentId) ?? [],
    diagnostics: decided?.diagnostics ?? [],
  };
}

interface Named {
  readonly agentId: string | undefined;
  readonly server: string;
  readonly tool: EngineTool;
  readonly key: string;
  readonly setting: boolean | undefined;
}

/**
 * The identities of the tools to defer: a tool's own setting, else, for an agent that searches
 * (`searches`), whether the JSON of its MCP tools that would be listed (`name`, `description`,
 * `inputSchema`) passes `deferShare` of the model's context window, at `charsPerToken` characters
 * a token. An agent that does not search and passes it is a diagnostic.
 */
function decideDeferral(
  named: readonly Named[],
  model: Pick<ModelDescriptor, "contextWindow"> | undefined,
  config: McpToolConfig,
  searches: (agentId: string | undefined) => boolean,
): { deferred: string[]; diagnostics: McpToolDiagnostic[] } {
  const window = model?.contextWindow ?? config.fallbackContextWindow;
  const limit = window * config.charsPerToken * config.deferShare;
  const listed = new Map<string | undefined, number>();
  for (const item of named) {
    if (item.setting === true) continue;
    const size = JSON.stringify({
      name: item.tool.name,
      description: item.tool.description ?? "",
      inputSchema: item.tool.inputSchema,
    }).length;
    listed.set(item.agentId, (listed.get(item.agentId) ?? 0) + size);
  }
  const over = (agentId: string | undefined) => (listed.get(agentId) ?? 0) > limit;
  const diagnostics: McpToolDiagnostic[] = [];
  for (const agentId of listed.keys())
    if (!searches(agentId) && over(agentId))
      diagnostics.push({
        code: "mcp_tools_inline",
        message: `The MCP tools of ${agentId === undefined ? "the agent" : `subagent ${agentId}`} take about ${Math.ceil(
          listed.get(agentId)! / config.charsPerToken,
        )} tokens, past ${config.deferShare * 100}% of a ${window}-token context window, and stay in its tool list: it does not declare engine.toolSearch. Declare it to defer them behind tool_search, or set deferred on the servers that can wait`,
        ...(agentId === undefined ? {} : { agentId }),
      });
  return {
    deferred: named.filter((item) => item.setting ?? (searches(item.agentId) && over(item.agentId))).map((item) => item.key),
    diagnostics,
  };
}

/** An input or output schema our engine can check calls against; undefined when it cannot. */
function usableSchema(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = JSON.parse(JSON.stringify(value)) as JsonObject;
  try {
    schemaFromJSON(schema);
  } catch {
    return undefined;
  }
  return schema;
}
