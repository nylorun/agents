/**
 * A session's MCP snapshot (protocol 15): what its remote MCP servers listed at discovery, raw
 * (`McpSnapshot`, `@nylorun/core/harness-api`), pinned on the session. The Runtime never names a
 * tool for the model: it states facts per turn (`mcpFactsOf`, `turn.start.mcp`), and checks a
 * call by its identity (`{server, tool}` of its agent): discovered (`mcpToolIn`) and left enabled
 * by the turn's manifest (`isEnabledIn`, R2b C9).
 */
import type { EventPayload } from "@nylorun/core/contracts";
import {
  delegatesOf,
  pluginOf,
  delegateManifest,
  mcpToolSettings,
  type AgentManifest,
  type ResolvedMcpToolSettings,
} from "@nylorun/core/define";
import type { McpFacts, McpServerRecord, McpSnapshot, McpToolRecord } from "@nylorun/core/harness-api";
import type { HostEffect } from "@nylorun/harness/run";
import { findServer } from "./pool.js";

export type { McpFacts, McpServerRecord, McpSnapshot, McpToolRecord } from "@nylorun/core/harness-api";

export interface McpDiagnostic {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly serverName: string;
  readonly outcome: "connected" | "refused" | "failed";
  readonly message: string;
  readonly credentialIds?: readonly string[];
  /** How many listed tools the server's `tools` settings disable (R2b C9). */
  readonly disabled?: number;
  /** Keys of the server's `tools` settings that name no tool it listed (R2b C9). */
  readonly unknownTools?: readonly string[];
}

/**
 * The `mcp.discovered` payload: each server's outcome, with the tools it added to the snapshot
 * that its settings in `manifest` (the session's pinned one) leave enabled, and the Agent Plugin
 * that brought the server.
 */
export function mcpDiscovered(
  snapshot: McpSnapshot,
  diagnostics: readonly McpDiagnostic[],
  manifest?: AgentManifest
): EventPayload<"mcp.discovered"> {
  const agents = new Map<string | undefined, AgentManifest>(
    manifest === undefined
      ? []
      : [[undefined, manifest], ...delegatesOf(manifest).map(({ manifest: child }) => [child.id, child] as const)]
  );
  const key = (agentId: string | undefined, serverName: string) => JSON.stringify([agentId ?? null, serverName]);
  const tools = new Map<string, number>();
  for (const server of snapshot.servers) {
    const enabled = server.tools.filter(
      (tool) => manifest === undefined || isEnabledIn(manifest, server.agentId, server.name, tool.name)
    );
    tools.set(key(server.agentId, server.name), enabled.length);
  }
  return {
    servers: diagnostics.map((item) => ({
      ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
      serverName: item.serverName,
      ...withPlugin(pluginOf(agents.get(item.agentId), { server: item.serverName })),
      outcome: item.outcome,
      message: item.message,
      tools: tools.get(key(item.agentId, item.serverName)) ?? 0,
      ...(item.disabled ? { disabled: item.disabled } : {}),
      ...(item.unknownTools?.length ? { unknownTools: [...item.unknownTools] } : {}),
      ...(item.credentialIds === undefined ? {} : { credentialIds: [...item.credentialIds] }),
    })),
  };
}

function withPlugin(plugin: ReturnType<typeof pluginOf>) {
  return plugin === undefined ? {} : { plugin };
}

/** The tool `tool` of server `server` of agent `agentId` (the root when absent), as discovered. */
export function mcpToolIn(
  snapshot: McpSnapshot | undefined,
  agentId: string | undefined,
  server: string,
  tool: string
): McpToolRecord | undefined {
  return snapshot?.servers
    .find((item) => item.agentId === agentId && item.name === server)
    ?.tools.find((item) => item.name === tool);
}

/** The tool's settings in `manifest` (R2b C9); the defaults when its server is not there. */
export function mcpToolSettingsIn(
  manifest: AgentManifest,
  agentId: string | undefined,
  server: string,
  tool: string
): ResolvedMcpToolSettings {
  const declared = findServer(manifest, agentId, server);
  return declared ? mcpToolSettings(declared.server, tool) : { enabled: true, approval: "never" };
}

/** True when the tool's settings in `manifest` leave it enabled (R2b C9). */
export function isEnabledIn(
  manifest: AgentManifest,
  agentId: string | undefined,
  server: string,
  tool: string
): boolean {
  return mcpToolSettingsIn(manifest, agentId, server, tool).enabled;
}

/**
 * The snapshot's facts for a turn whose manifest is `manifest` (the session's pin, or a turn
 * variant that tightened its MCP servers' tools): each tool with whether its settings leave it
 * `enabled` and, when they say, whether to defer it. A server the turn's manifest no longer
 * declares is left out.
 */
export function mcpFactsOf(snapshot: McpSnapshot, manifest: AgentManifest): McpFacts {
  return {
    servers: snapshot.servers.flatMap((server) => {
      if (!findServer(manifest, server.agentId, server.name)) return [];
      return [
        {
          ...(server.agentId === undefined ? {} : { agentId: server.agentId }),
          name: server.name,
          ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
          tools: server.tools.map((tool) => {
            const settings = mcpToolSettingsIn(manifest, server.agentId, server.name, tool.name);
            return {
              ...tool,
              enabled: settings.enabled,
              ...(settings.deferred === undefined ? {} : { deferred: settings.deferred }),
            };
          }),
        },
      ];
    }),
  };
}

/** The manifest of the agent an effect belongs to: the root, or an agent it uses as a tool. */
export function manifestFor(
  manifest: AgentManifest,
  agent: HostEffect["agent"]
): AgentManifest | undefined {
  return agent ? delegateManifest(manifest, agent.id) : manifest;
}

/**
 * `snapshot` within the Tenant's Runtime limit `mcpSnapshotBytes` (its JSON, which every
 * `turn.start.mcp` carries): its servers in order while they fit. A server that does not is left
 * out, so the session never offers its tools, and its diagnostic says so (`failed`, replacing
 * the one it had). Unchanged when the whole snapshot fits.
 */
export function fitSnapshot(
  snapshot: McpSnapshot,
  diagnostics: readonly McpDiagnostic[],
  limitBytes: number,
): { snapshot: McpSnapshot; diagnostics: McpDiagnostic[] } {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (bytes(snapshot) <= limitBytes) return { snapshot, diagnostics: [...diagnostics] };
  const kept: McpServerRecord[] = [];
  const dropped = new Map<string, number>();
  const key = (agentId: string | undefined, serverName: string) => JSON.stringify([agentId ?? null, serverName]);
  for (const server of snapshot.servers) {
    const next = { ...snapshot, servers: [...kept, server] };
    const size = bytes(next);
    if (size <= limitBytes) kept.push(server);
    else dropped.set(key(server.agentId, server.name), bytes(server));
  }
  const tooLarge = (agentId: string | undefined, serverName: string, size: number): McpDiagnostic => ({
    ...(agentId === undefined ? {} : { agentId }),
    serverName,
    outcome: "failed",
    message: `The server's tools and instructions take ${size} bytes, past what the session may pin with the rest: the Runtime limit mcpSnapshotBytes (${limitBytes} bytes; PUT /v1/tenant/limits). Its tools are not offered.`,
  });
  const out = diagnostics.map((item) => {
    const size = dropped.get(key(item.agentId, item.serverName));
    return size === undefined ? item : tooLarge(item.agentId, item.serverName, size);
  });
  for (const server of snapshot.servers) {
    const size = dropped.get(key(server.agentId, server.name));
    if (size !== undefined && !out.some((item) => key(item.agentId, item.serverName) === key(server.agentId, server.name)))
      out.push(tooLarge(server.agentId, server.name, size));
  }
  return { snapshot: { ...snapshot, servers: kept }, diagnostics: out };
}

/** True for a snapshot of the shape this Runtime pins (`snapshotSchemaVersion` 2). */
export function isSnapshot(value: unknown): value is McpSnapshot {
  const snapshot = value as Partial<McpSnapshot> | null;
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    snapshot.snapshotSchemaVersion === 2 &&
    typeof snapshot.manifestHash === "string" &&
    Array.isArray(snapshot.servers)
  );
}
