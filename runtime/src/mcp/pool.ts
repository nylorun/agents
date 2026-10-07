import type { AgentManifest, McpServerManifest } from "@nylorun/core/define";
import { delegatesOf } from "@nylorun/core/define";
import type { OutboundPolicy } from "../tenant/outbound.js";
import type { AuthorizeResult } from "../vault/service.js";
import {
  callMcpTool,
  diagnosticFromError,
  listMcpTools,
  McpConnectionStale,
  openMcpServer,
  unreachable,
  type LiveConnection,
  type McpToolFailure,
  type McpToolOutcome,
} from "./connect.js";
import {
  declaredToolNames,
  type McpDiagnostic,
  type McpServerNote,
  type McpSnapshot,
  type McpToolRecord,
} from "./snapshot.js";

/** A connection unused this long is closed by the sweep; the next call opens it again. */
export const DEFAULT_MCP_IDLE_MS = 15 * 60_000;

interface LiveServer {
  readonly capabilityId: string;
  readonly serverName: string;
  readonly connection: LiveConnection;
  lastUsedAt: number;
  /** Calls in progress; a connection with any is never closed as idle. */
  active: number;
  /** Out of the pool (`McpConnectionStale`): closed when its last call ends. */
  evicted?: boolean;
}

type Opened =
  | { ok: true; connection: LiveConnection }
  | { ok: false; diagnostic: McpDiagnostic; error: unknown };

export class McpPool {
  private readonly live = new Map<string, LiveServer>();
  /** Connections being opened by `call`, so concurrent calls share one. */
  private readonly opening = new Map<string, Promise<Opened>>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly open: typeof openMcpServer;

  constructor(
    private readonly options: {
      readonly authorize: (
        sessionId: string,
        request: { url: string; serverName: string; agentId?: string },
      ) => Promise<AuthorizeResult>;
      /** Default `DEFAULT_MCP_IDLE_MS`. */
      readonly idleMs?: number;
      readonly now?: () => number;
      /** Tests replace how a declared server is opened. */
      readonly open?: typeof openMcpServer;
      /** How remote servers opened in this process are reached (`TenantConfig.delivery`). */
      readonly policy?: OutboundPolicy;
      /**
       * Opens a remote (`streamable-http` or `sse`) server somewhere else: the gates service
       * holds the connection and its credential, and the loop never sees either (F4.1).
       * Absent: they are opened in this process, with `authorize`.
       */
      readonly openRemote?: (server: McpServerRef) => Promise<LiveConnection>;
    },
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_MCP_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.open = options.open ?? openMcpServer;
  }

  async discover(input: {
    sessionId: string;
    manifest: AgentManifest;
    manifestHash: string;
    signal?: AbortSignal;
  }): Promise<{ snapshot: McpSnapshot; diagnostics: McpDiagnostic[] }> {
    // Each agent names its own tools, so collisions are checked per agent.
    const taken = new Map<string | undefined, Set<string>>();
    const tools: McpToolRecord[] = [];
    const notes: McpServerNote[] = [];
    const diagnostics: McpDiagnostic[] = [];
    for (const declared of serversOf(input.manifest)) {
      input.signal?.throwIfAborted();
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) {
        diagnostics.push(opened.diagnostic);
        continue;
      }
      try {
        if (!taken.has(declared.agentId))
          taken.set(declared.agentId, declaredToolNames(declared.manifest));
        const listed = await listMcpTools(opened.connection.client, {
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
          taken: taken.get(declared.agentId)!,
          server: declared.server,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        tools.push(...listed.tools.map((tool) => owned(declared, tool)));
        if (opened.connection.instructions)
          notes.push(
            owned(declared, {
              capabilityId: declared.capabilityId,
              serverName: declared.server.name,
              instructions: opened.connection.instructions,
            }),
          );
        diagnostics.push({
          ...ownerOf(declared),
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
          outcome: "connected",
          message: [
            "Connected",
            ...(listed.omitted.length === 0 ? [] : [`Omitted ${listed.omitted.join(", ")}`]),
            ...(listed.unknownTools.length === 0
              ? []
              : [`Its tools settings name tools it does not list: ${listed.unknownTools.join(", ")}`]),
          ].join(". "),
          ...(listed.renamed.length === 0 ? {} : { renamed: listed.renamed }),
          ...(listed.disabled === 0 ? {} : { disabled: listed.disabled }),
          ...(listed.unknownTools.length === 0 ? {} : { unknownTools: listed.unknownTools }),
        });
        this.remember(input.sessionId, declared, opened.connection);
      } catch (error) {
        await opened.connection.close().catch(() => {});
        diagnostics.push(
          owned(declared, diagnosticFromError(declared.capabilityId, declared.server.name, error)),
        );
      }
    }
    return {
      snapshot: {
        snapshotSchemaVersion: 1,
        manifestHash: input.manifestHash,
        mcpTools: tools,
        ...(notes.length === 0 ? {} : { servers: notes }),
      },
      diagnostics,
    };
  }

  async reconnect(input: {
    sessionId: string;
    manifest: AgentManifest;
    tools: readonly McpToolRecord[];
    signal?: AbortSignal;
  }): Promise<McpDiagnostic[]> {
    const diagnostics: McpDiagnostic[] = [];
    const seen = new Set<string>();
    for (const tool of input.tools) {
      const key = this.liveKey(input.sessionId, tool.agentId, tool.capabilityId, tool.serverName);
      if (seen.has(key)) continue;
      seen.add(key);
      const live = this.live.get(key);
      if (live) {
        // The advance is about to use it: not idle.
        live.lastUsedAt = this.now();
        continue;
      }
      input.signal?.throwIfAborted();
      const declared = findServer(input.manifest, tool.agentId, tool.capabilityId, tool.serverName);
      if (!declared) {
        diagnostics.push({
          ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
          capabilityId: tool.capabilityId,
          serverName: tool.serverName,
          outcome: "failed",
          message: "Declared MCP server is missing from the pinned manifest",
        });
        continue;
      }
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) {
        diagnostics.push(opened.diagnostic);
        continue;
      }
      this.remember(input.sessionId, declared, opened.connection);
    }
    return diagnostics;
  }

  async call(input: {
    sessionId: string;
    agentId?: string;
    capabilityId: string;
    serverName: string;
    serverToolName: string;
    args: unknown;
    manifest: AgentManifest;
    /** The effect id: a gate runs the call once under it (F4.1). */
    effectId?: string;
    /** The tool is read-only or idempotent: a lost answer is the model's to retry (R2b C7). */
    retrySafe?: boolean;
    signal?: AbortSignal;
  }): Promise<McpToolOutcome> {
    const key = this.liveKey(input.sessionId, input.agentId, input.capabilityId, input.serverName);
    for (let attempt = 0; ; attempt += 1) {
      const live = await this.liveFor(input, key);
      // No connection, so no call was sent: the model sees why, a 401 included (R2b C1, C7).
      if (!("connection" in live)) return live;
      live.active += 1;
      try {
        return await callMcpTool(live.connection.client, input.serverToolName, input.args, {
          ...(input.effectId === undefined ? {} : { key: input.effectId }),
          ...(input.retrySafe ? { retrySafe: true } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        if (!(error instanceof McpConnectionStale)) throw error;
        // The server ended the connection's session, or its credential now sends it elsewhere,
        // and the tool never saw the call: drop the connection and send it once more on a new one.
        this.evict(key, live);
        if (attempt > 0) return error.outcome();
      } finally {
        live.active -= 1;
        live.lastUsedAt = this.now();
        if (live.evicted && live.active === 0) void live.connection.close().catch(() => {});
      }
    }
  }

  /** The session's connection to the server, opened when there is none, or why it cannot be. */
  private async liveFor(
    input: { sessionId: string; agentId?: string; capabilityId: string; serverName: string; manifest: AgentManifest },
    key: string,
  ): Promise<LiveServer | McpToolFailure> {
    const live = this.live.get(key);
    if (live) return live;
    const declared = findServer(input.manifest, input.agentId, input.capabilityId, input.serverName);
    if (!declared) throw new Error(`MCP server '${input.serverName}' is not declared`);
    let opening = this.opening.get(key);
    if (!opening) {
      opening = this.connectDeclared(input, declared).finally(() => this.opening.delete(key));
      this.opening.set(key, opening);
    }
    const opened = await opening;
    if (!opened.ok) return unreachable(input.serverName, opened.error).outcome();
    return this.remember(input.sessionId, declared, opened.connection);
  }

  /**
   * Takes a connection out of the pool, so the next call opens a new one. Calls still running on
   * it finish first: the last one closes it.
   */
  private evict(key: string, live: LiveServer): void {
    if (this.live.get(key) === live) this.live.delete(key);
    live.evicted = true;
  }

  /**
   * Closes connections unused for the idle timeout (the Tenant sweep). A session that calls
   * one again reconnects, as after a restart; this bounds the connections a Tenant keeps.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const idle: LiveServer[] = [];
    for (const [key, live] of this.live) {
      if (live.active > 0 || now - live.lastUsedAt < this.idleMs) continue;
      this.live.delete(key);
      idle.push(live);
    }
    await Promise.all(idle.map((item) => item.connection.close().catch(() => {})));
  }

  async close(): Promise<void> {
    const connections = [...this.live.values()];
    this.live.clear();
    await Promise.all(connections.map((item) => item.connection.close().catch(() => {})));
  }

  /** Keeps the connection, or closes it when the server is already connected for the session. */
  private remember(
    sessionId: string,
    declared: DeclaredServer,
    connection: LiveConnection,
  ): LiveServer {
    const key = this.liveKey(
      sessionId,
      declared.agentId,
      declared.capabilityId,
      declared.server.name,
    );
    const existing = this.live.get(key);
    if (existing) {
      if (existing.connection !== connection) void connection.close().catch(() => {});
      return existing;
    }
    const live: LiveServer = {
      capabilityId: declared.capabilityId,
      serverName: declared.server.name,
      connection,
      lastUsedAt: this.now(),
      active: 0,
    };
    this.live.set(key, live);
    return live;
  }

  private liveKey(
    sessionId: string,
    agentId: string | undefined,
    capabilityId: string,
    serverName: string,
  ): string {
    return JSON.stringify([sessionId, agentId ?? null, capabilityId, serverName]);
  }

  private async connectDeclared(
    input: { sessionId: string },
    declared: DeclaredServer,
  ): Promise<Opened> {
    try {
      if (this.options.openRemote) {
        const connection = await this.options.openRemote({
          sessionId: input.sessionId,
          ...ownerOf(declared),
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
        });
        return { ok: true, connection };
      }
      const connection = await this.open({
        server: declared.server,
        ...(this.options.policy ? { policy: this.options.policy } : {}),
        authorize: (url) =>
          this.options.authorize(input.sessionId, {
            url,
            serverName: declared.server.name,
            ...ownerOf(declared),
          }),
      });
      return { ok: true, connection };
    } catch (error) {
      return {
        ok: false,
        error,
        diagnostic: owned(
          declared,
          diagnosticFromError(declared.capabilityId, declared.server.name, error),
        ),
      };
    }
  }
}

/** One declared MCP server of a session: what a gate needs to find it in the pinned manifest. */
export interface McpServerRef {
  readonly sessionId: string;
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
}

export interface DeclaredServer {
  /** Absent for the session's root agent. */
  readonly agentId?: string;
  /** The manifest of the agent that declares the server. */
  readonly manifest: AgentManifest;
  readonly capabilityId: string;
  readonly server: McpServerManifest;
}

/** Servers of the root agent, then of each agent it uses as a tool. */
export function serversOf(manifest: AgentManifest): DeclaredServer[] {
  const servers: DeclaredServer[] = [];
  const add = (agent: AgentManifest, agentId?: string) => {
    for (const capability of agent.capabilities)
      for (const server of Object.values(capability.mcpServers ?? {}))
        servers.push({
          ...(agentId === undefined ? {} : { agentId }),
          manifest: agent,
          capabilityId: capability.id,
          server,
        });
  };
  add(manifest);
  for (const child of delegatesOf(manifest)) add(child.manifest, child.manifest.id);
  return servers;
}

export function findServer(
  manifest: AgentManifest,
  agentId: string | undefined,
  capabilityId: string,
  serverName: string,
): DeclaredServer | undefined {
  return serversOf(manifest).find(
    (item) =>
      item.agentId === agentId &&
      item.capabilityId === capabilityId &&
      item.server.name === serverName,
  );
}

function ownerOf(declared: DeclaredServer): { agentId?: string } {
  return declared.agentId === undefined ? {} : { agentId: declared.agentId };
}

function owned<T extends object>(declared: DeclaredServer, value: T): T {
  return { ...ownerOf(declared), ...value };
}
