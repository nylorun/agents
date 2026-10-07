import { createHash } from "node:crypto";
import type { EventPayload } from "@nylorun/core/contracts";
import type { JsonObject } from "@nylorun/core/define";
import { delegateManifest, type AgentManifest } from "@nylorun/core/define";
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
}

export interface McpSnapshot {
  readonly snapshotSchemaVersion: 1;
  readonly manifestHash: string;
  readonly mcpTools: readonly McpToolRecord[];
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
  for (const tool of snapshot.mcpTools) tools.set(key(tool), (tools.get(key(tool)) ?? 0) + 1);
  return {
    servers: diagnostics.map((item) => ({
      ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
      capabilityId: item.capabilityId,
      serverName: item.serverName,
      outcome: item.outcome,
      message: item.message,
      tools: tools.get(key(item)) ?? 0,
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

/**
 * The tools of a snapshot, as the engine advertises them. A tool of a server whose `approval` is
 * `always` in the session's `manifest` waits for approval on each call.
 */
export function sessionToolsOf(
  snapshot: McpSnapshot | undefined,
  manifest: AgentManifest
): readonly DurableSessionTool[] | undefined {
  if (!snapshot?.mcpTools.length) return undefined;
  const approved = (tool: McpToolRecord) => {
    const agent = tool.agentId === undefined ? manifest : delegateManifest(manifest, tool.agentId);
    const server = agent?.capabilities.find((item) => item.id === tool.capabilityId)?.mcpServers?.[
      tool.serverName
    ];
    return server !== undefined && "approval" in server && server.approval === "always";
  };
  return snapshot.mcpTools.map((tool) => ({
    ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
    capabilityId: tool.capabilityId,
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    ...(approved(tool) ? { approval: "always" as const } : {}),
  }));
}

/** The snapshot's record of an MCP tool call, or undefined when the call is not an MCP tool. */
export function mcpToolOf(
  snapshot: McpSnapshot | undefined,
  request: Pick<HostEffect, "agent" | "capabilityId" | "toolName">
): McpToolRecord | undefined {
  return snapshot?.mcpTools.find(
    (tool) =>
      tool.agentId === request.agent?.id &&
      tool.capabilityId === request.capabilityId &&
      tool.name === request.toolName
  );
}

/** The manifest of the agent an effect belongs to: the root, or an agent it uses as a tool. */
export function manifestFor(
  manifest: AgentManifest,
  agent: HostEffect["agent"]
): AgentManifest | undefined {
  return agent ? delegateManifest(manifest, agent.id) : manifest;
}
