import type { EventPayload } from "@nylorun/core/contracts";
import type { JsonObject } from "@nylorun/core/define";
import { delegateManifest, type AgentManifest } from "@nylorun/core/define";
import type { DurableSessionTool, HostEffect } from "@nylorun/harness/run";

export interface McpToolRecord {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  readonly serverToolName: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
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
    })),
  };
}

export function modelToolName(serverName: string, serverToolName: string): string {
  return `${serverName}__${serverToolName}`;
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
