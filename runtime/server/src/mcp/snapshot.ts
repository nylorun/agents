import { createHash } from "node:crypto";
import type { EventPayload } from "@nylorun/core/contracts";
import type { JsonObject } from "@nylorun/core/define";
import {
  TOOLS_CAPABILITY_ID,
  deferredToolsInstructions,
  deferredToolsTools,
  delegateManifest,
  mcpToolSettings,
  type AgentManifest,
  type McpServerManifest,
  type ResolvedMcpToolSettings,
} from "@nylorun/core/define";
import type { DurableSessionTool, HostEffect } from "@nylorun/harness/run";

export interface McpToolRecord {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  /** The tool's name on its server, which the call sends. */
  readonly serverToolName: string;
  /** The name the model knows it by (`normalizeToolName`). */
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /**
   * The server's hints that calling the tool again is safe (R2b C7, Q15): a call whose answer
   * was lost after it was sent is then `mcp.lost` to the model, not `uncertain`.
   */
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly idempotentHint?: boolean };
  /**
   * Out of the model's tool list for the session's life (R2b C10): core decides it once, when it
   * records the snapshot (`pinDeferral`), so every model call of the session lists the same tools.
   */
  readonly deferred?: true;
}

/** A server's own instructions (MCP `initialize`), for the note on its deferred tools (R2b C10). */
export interface McpServerNote {
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  /** Cut to `SERVER_INSTRUCTIONS_MAX_CHARS`. */
  readonly instructions: string;
}

export interface McpSnapshot {
  readonly snapshotSchemaVersion: 1;
  readonly manifestHash: string;
  readonly mcpTools: readonly McpToolRecord[];
  /** The servers that gave instructions; absent when none did. */
  readonly servers?: readonly McpServerNote[];
}

export interface McpDiagnostic {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  readonly outcome: "connected" | "refused" | "failed";
  readonly message: string;
  readonly credentialIds?: readonly string[];
  /** Tools the model knows by another name than `server__tool` (R2b C6). */
  readonly renamed?: readonly McpRenamedTool[];
  /** How many listed tools the server's `tools` settings disable (R2b C9). */
  readonly disabled?: number;
  /** Keys of the server's `tools` settings that name no tool it listed (R2b C9). */
  readonly unknownTools?: readonly string[];
}

/** A tool whose model-facing name is not `server__tool` (`normalizeToolName`). */
export interface McpRenamedTool {
  readonly serverToolName: string;
  readonly name: string;
}

/** The `mcp.discovered` payload: each server's outcome, with the tools it added to the snapshot. */
export function mcpDiscovered(
  snapshot: McpSnapshot,
  diagnostics: readonly McpDiagnostic[]
): EventPayload<"mcp.discovered"> {
  const key = (item: { agentId?: string; capabilityId: string; serverName: string }) =>
    JSON.stringify([item.agentId ?? null, item.capabilityId, item.serverName]);
  const tools = new Map<string, number>();
  const deferred = new Map<string, number>();
  for (const tool of snapshot.mcpTools) {
    tools.set(key(tool), (tools.get(key(tool)) ?? 0) + 1);
    if (tool.deferred) deferred.set(key(tool), (deferred.get(key(tool)) ?? 0) + 1);
  }
  return {
    servers: diagnostics.map((item) => ({
      ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
      capabilityId: item.capabilityId,
      serverName: item.serverName,
      outcome: item.outcome,
      message: item.message,
      tools: tools.get(key(item)) ?? 0,
      ...(deferred.has(key(item)) ? { deferred: deferred.get(key(item))! } : {}),
      ...(item.disabled ? { disabled: item.disabled } : {}),
      ...(item.unknownTools?.length ? { unknownTools: [...item.unknownTools] } : {}),
      ...(item.credentialIds === undefined ? {} : { credentialIds: [...item.credentialIds] }),
      ...(item.renamed?.length ? { renamed: item.renamed.map((tool) => ({ ...tool })) } : {}),
    })),
  };
}

/** The longest tool name every model provider accepts (R2b C6, Q14). */
export const MODEL_TOOL_NAME_MAX = 64;

/**
 * The name the model knows an MCP tool by (R2b C6, Q13): `server__tool`, with each character
 * outside `[A-Za-z0-9_-]` replaced by `_`, since MCP allows `.` and 128 characters and OpenAI,
 * Bedrock and Gemini on Vertex do not. A name over 64 characters, or one that collides
 * (`suffixed`), keeps 55 and adds `_` and 8 hex characters of the SHA-256 of the raw
 * `server/tool`.
 */
export function normalizeToolName(
  serverName: string,
  serverToolName: string,
  options: { readonly suffixed?: boolean } = {}
): string {
  const name = `${serverName}__${serverToolName}`.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (name.length <= MODEL_TOOL_NAME_MAX && !options.suffixed) return name;
  const hash = createHash("sha256")
    .update(`${serverName}/${serverToolName}`)
    .digest("hex")
    .slice(0, 8);
  return `${name.slice(0, MODEL_TOOL_NAME_MAX - 9)}_${hash}`;
}

export function declaredToolNames(manifest: AgentManifest): Set<string> {
  const names = new Set<string>();
  for (const capability of manifest.capabilities)
    for (const tool of capability.tools ?? []) names.add(tool.name);
  return names;
}

/** The declaration of the server a tool of the snapshot comes from, in `manifest`. */
function serverOf(manifest: AgentManifest, tool: McpToolRecord): McpServerManifest | undefined {
  const agent = tool.agentId === undefined ? manifest : delegateManifest(manifest, tool.agentId);
  return agent?.capabilities.find((item) => item.id === tool.capabilityId)?.mcpServers?.[tool.serverName];
}

/** The tool's settings in `manifest` (R2b C9); the defaults when its server is not there. */
function settingsOf(manifest: AgentManifest, tool: McpToolRecord): ResolvedMcpToolSettings {
  const server = serverOf(manifest, tool);
  return server ? mcpToolSettings(server, tool.serverToolName) : { enabled: true, approval: "never" };
}

/** True when the agent the tool belongs to has `tool_search` and `tool_call` (`nylorun.tools`). */
function reachesDeferred(manifest: AgentManifest, agentId: string | undefined): boolean {
  const agent = agentId === undefined ? manifest : delegateManifest(manifest, agentId);
  return agent?.capabilities.some((capability) => capability.id === TOOLS_CAPABILITY_ID) === true;
}

/**
 * The tools of a snapshot, as the engine gets them for a turn whose manifest is `manifest` (the
 * session's pin, or a turn variant that tightened its MCP servers' tools):
 *
 * - a tool its settings disable is left out (R2b C9); one whose approval resolves to `always`
 *   waits for approval on each call;
 * - a deferred tool (R2b C10) is marked so, out of the model's list, and its agent gets
 *   `tool_search`, with the note on the servers it holds deferred tools of, and `tool_call` in
 *   its `nylorun.tools` capability. An agent whose turn has no such capability keeps its tools in
 *   its list.
 *
 * Nothing here changes between the steps of a turn, so neither does the model's tool list.
 */
export function sessionToolsOf(
  snapshot: McpSnapshot | undefined,
  manifest: AgentManifest
): readonly DurableSessionTool[] | undefined {
  if (!snapshot?.mcpTools.length) return undefined;
  const inline: DurableSessionTool[] = [];
  const deferred = new Map<string | undefined, DurableSessionTool[]>();
  const notes = new Map<string | undefined, Map<string, number>>();
  for (const tool of snapshot.mcpTools) {
    const settings = settingsOf(manifest, tool);
    if (!settings.enabled) continue;
    const defer = tool.deferred === true && reachesDeferred(manifest, tool.agentId);
    const entry: DurableSessionTool = {
      ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
      capabilityId: tool.capabilityId,
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(settings.approval === "always" ? { approval: "always" as const } : {}),
      ...(defer ? { deferred: true } : {}),
    };
    if (!defer) {
      inline.push(entry);
      continue;
    }
    deferred.set(tool.agentId, [...(deferred.get(tool.agentId) ?? []), entry]);
    const servers = notes.get(tool.agentId) ?? new Map<string, number>();
    servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + 1);
    notes.set(tool.agentId, servers);
  }
  const platform: DurableSessionTool[] = [];
  for (const [agentId, tools] of deferred) {
    const servers = [...notes.get(agentId)!].map(([serverName, count]) => {
      const instructions = snapshot.servers?.find(
        (item) => item.agentId === agentId && item.serverName === serverName
      )?.instructions;
      return { serverName, tools: count, ...(instructions ? { instructions } : {}) };
    });
    const [search, call] = deferredToolsTools();
    for (const tool of [
      { ...search!, instructions: [deferredToolsInstructions(servers)] },
      call!,
    ])
      platform.push({
        ...(agentId === undefined ? {} : { agentId }),
        capabilityId: TOOLS_CAPABILITY_ID,
        ...tool,
      });
    platform.push(...tools);
  }
  return [...inline, ...platform];
}

/** The share of the model's context window past which an agent's MCP tools are deferred (Q21). */
export const DEFER_CONTEXT_SHARE = 0.1;
/** Characters per token, to estimate what tool definitions take of a context window (Q21). */
export const CHARS_PER_TOKEN = 4;

/**
 * The snapshot with its deferred tools marked (R2b C10, Q21), decided once for the session when
 * core records it. A tool's own setting, then `"*"`'s, then its server's, decides; a tool none
 * sets is deferred when the JSON of its agent's MCP tools that would be listed passes a tenth of
 * the model's context window (`contextWindow` tokens, at 4 characters a token). An agent without
 * the `nylorun.tools` capability (its definition names a tool `tool_search` or `tool_call`, or the
 * session was opened before it existed) defers nothing.
 */
export function pinDeferral(
  snapshot: McpSnapshot,
  manifest: AgentManifest,
  contextWindow: number
): McpSnapshot {
  const limit = contextWindow * CHARS_PER_TOKEN * DEFER_CONTEXT_SHARE;
  const listed = new Map<string | undefined, number>();
  const set = snapshot.mcpTools.map((tool) => settingsOf(manifest, tool).deferred);
  snapshot.mcpTools.forEach((tool, i) => {
    if (set[i] === true) return;
    const size = JSON.stringify({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }).length;
    listed.set(tool.agentId, (listed.get(tool.agentId) ?? 0) + size);
  });
  const mcpTools = snapshot.mcpTools.map((tool, i): McpToolRecord => {
    const { deferred: _, ...rest } = tool;
    if (!reachesDeferred(manifest, tool.agentId)) return rest;
    const defer = set[i] ?? (listed.get(tool.agentId) ?? 0) > limit;
    return defer ? { ...rest, deferred: true } : rest;
  });
  return { ...snapshot, mcpTools };
}

/**
 * The snapshot's record of an MCP tool call, or undefined when the call is not an MCP tool. With
 * the turn's `manifest`, a tool its settings disable is not one either (R2b C9).
 */
export function mcpToolOf(
  snapshot: McpSnapshot | undefined,
  request: Pick<HostEffect, "agent" | "capabilityId" | "toolName">,
  manifest?: AgentManifest
): McpToolRecord | undefined {
  const tool = snapshot?.mcpTools.find(
    (tool) =>
      tool.agentId === request.agent?.id &&
      tool.capabilityId === request.capabilityId &&
      tool.name === request.toolName
  );
  if (tool && manifest && !isEnabledIn(manifest, tool)) return undefined;
  return tool;
}

/** True when the tool's settings in `manifest` leave it enabled (R2b C9). */
export function isEnabledIn(manifest: AgentManifest, tool: McpToolRecord): boolean {
  return settingsOf(manifest, tool).enabled;
}

/** The manifest of the agent an effect belongs to: the root, or an agent it uses as a tool. */
export function manifestFor(
  manifest: AgentManifest,
  agent: HostEffect["agent"]
): AgentManifest | undefined {
  return agent ? delegateManifest(manifest, agent.id) : manifest;
}
