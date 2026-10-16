import type { AgentManifest, McpServerManifest } from "@nylorun/core/define";
import { delegatesOf } from "@nylorun/core/define";
import {
  callMcpTool,
  diagnosticFromError,
  listMcpTools,
  McpConnectionStale,
  unreachable,
  type LiveConnection,
  type McpToolFailure,
  type McpToolOutcome,
} from "./connect.js";
import type { McpDiagnostic, McpServerRecord, McpSnapshot } from "./snapshot.js";
import { hostTuning } from "../tuning.js";

interface LiveServer {
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

  constructor(
    private readonly options: {
      /**
       * A connection unused this long is closed by the sweep; the next call opens it again.
       * Default `harness.mcpIdleMs` (Host tuning, 15 min).
       */
      readonly idleMs?: number;
      readonly now?: () => number;
      /**
       * Opens a declared remote (`streamable-http` or `sse`) server through a Tool Gate
       * (`ToolGate.openMcp`): the gate finds it in the session's pinned manifest and holds its
       * credential, and the pool never sees either (F4.1, protocol 15).
       */
      readonly openRemote: (server: McpServerRef) => Promise<LiveConnection>;
    },
  ) {
    this.idleMs = options.idleMs ?? hostTuning().harness.mcpIdleMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Opens each declared server of the session and lists its tools (protocol 15): the snapshot
   * holds every server that connected, with its instructions and its tools as it named them.
   * Instructions past `maxInstructionBytes` (the Runtime limit `recordEntryBytes`) are left out,
   * and the server's diagnostic says so.
   */
  async discover(input: {
    sessionId: string;
    manifest: AgentManifest;
    manifestHash: string;
    maxInstructionBytes: number;
    signal?: AbortSignal;
  }): Promise<{ snapshot: McpSnapshot; diagnostics: McpDiagnostic[] }> {
    const servers: McpServerRecord[] = [];
    const diagnostics: McpDiagnostic[] = [];
    for (const declared of serversOf(input.manifest)) {
      input.signal?.throwIfAborted();
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) {
        diagnostics.push(opened.diagnostic);
        continue;
      }
      try {
        const listed = await listMcpTools(opened.connection.client, {
          serverName: declared.server.name,
          server: declared.server,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const text = opened.connection.instructions;
        const tooLong = text !== undefined && Buffer.byteLength(text) > input.maxInstructionBytes;
        servers.push(
          owned(declared, {
            name: declared.server.name,
            ...(text === undefined || tooLong ? {} : { instructions: text }),
            tools: listed.tools,
          }),
        );
        diagnostics.push({
          ...ownerOf(declared),
          serverName: declared.server.name,
          outcome: "connected",
          message: [
            "Connected",
            ...(listed.omitted.length === 0 ? [] : [`Omitted ${listed.omitted.join(", ")}`]),
            ...(listed.unknownTools.length === 0
              ? []
              : [`Its tools settings name tools it does not list: ${listed.unknownTools.join(", ")}`]),
            ...(tooLong
              ? [
                  `Its instructions are ${Buffer.byteLength(text!)} bytes, more than a record entry holds (the Runtime limit recordEntryBytes, ${input.maxInstructionBytes} bytes), and are left out`,
                ]
              : []),
          ].join(". "),
          ...(listed.disabled === 0 ? {} : { disabled: listed.disabled }),
          ...(listed.unknownTools.length === 0 ? {} : { unknownTools: listed.unknownTools }),
        });
        this.remember(input.sessionId, declared, opened.connection);
      } catch (error) {
        await opened.connection.close().catch(() => {});
        diagnostics.push(
          owned(declared, diagnosticFromError(declared.server.name, error)),
        );
      }
    }
    return {
      snapshot: { snapshotSchemaVersion: 2, manifestHash: input.manifestHash, servers },
      diagnostics,
    };
  }

  /** Opens again each server of the snapshot this process holds no connection to. */
  async reconnect(input: {
    sessionId: string;
    manifest: AgentManifest;
    servers: readonly { readonly agentId?: string; readonly name: string }[];
    signal?: AbortSignal;
  }): Promise<McpDiagnostic[]> {
    const diagnostics: McpDiagnostic[] = [];
    const seen = new Set<string>();
    for (const server of input.servers) {
      const key = this.liveKey(input.sessionId, server.agentId, server.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const live = this.live.get(key);
      if (live) {
        // The advance is about to use it: not idle.
        live.lastUsedAt = this.now();
        continue;
      }
      input.signal?.throwIfAborted();
      const declared = findServer(input.manifest, server.agentId, server.name);
      if (!declared) {
        diagnostics.push({
          ...(server.agentId === undefined ? {} : { agentId: server.agentId }),
          serverName: server.name,
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
    serverName: string;
    serverToolName: string;
    args: unknown;
    manifest: AgentManifest;
    /** The effect id: a gate runs the call once under it (F4.1). */
    effectId?: string;
    /** The call's span context (R7.4), sent as `traceparent` on a connection this process holds. */
    traceparent?: string;
    /**
     * The largest answer kept on a connection this process holds: the Runtime limit
     * `toolAnswerBytes` (`turn.start.limits`). The gates service reads its own.
     */
    maxResultBytes: number;
    signal?: AbortSignal;
  }): Promise<McpToolOutcome> {
    const key = this.liveKey(input.sessionId, input.agentId, input.serverName);
    for (let attempt = 0; ; attempt += 1) {
      const live = await this.liveFor(input, key);
      // No connection, so no call was sent: the model sees why, a 401 included (R2b C1, C7).
      if (!("connection" in live)) return live;
      live.active += 1;
      try {
        return await callMcpTool(live.connection.client, input.serverToolName, input.args, {
          ...(input.effectId === undefined ? {} : { key: input.effectId }),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
          maxResultBytes: input.maxResultBytes,
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
    input: { sessionId: string; agentId?: string; serverName: string; manifest: AgentManifest },
    key: string,
  ): Promise<LiveServer | McpToolFailure> {
    const live = this.live.get(key);
    if (live) return live;
    const declared = findServer(input.manifest, input.agentId, input.serverName);
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
    const key = this.liveKey(sessionId, declared.agentId, declared.server.name);
    const existing = this.live.get(key);
    if (existing) {
      if (existing.connection !== connection) void connection.close().catch(() => {});
      return existing;
    }
    const live: LiveServer = {
      serverName: declared.server.name,
      connection,
      lastUsedAt: this.now(),
      active: 0,
    };
    this.live.set(key, live);
    return live;
  }

  private liveKey(sessionId: string, agentId: string | undefined, serverName: string): string {
    return JSON.stringify([sessionId, agentId ?? null, serverName]);
  }

  private async connectDeclared(
    input: { sessionId: string },
    declared: DeclaredServer,
  ): Promise<Opened> {
    try {
      const connection = await this.options.openRemote({
        sessionId: input.sessionId,
        ...ownerOf(declared),
        serverName: declared.server.name,
      });
      return { ok: true, connection };
    } catch (error) {
      return {
        ok: false,
        error,
        diagnostic: owned(declared, diagnosticFromError(declared.server.name, error)),
      };
    }
  }
}

/** One declared MCP server of a session: what a gate needs to find it in the pinned manifest. */
export interface McpServerRef {
  readonly sessionId: string;
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly serverName: string;
}

export interface DeclaredServer {
  /** Absent for the session's root agent. */
  readonly agentId?: string;
  /** The manifest of the agent that declares the server. */
  readonly manifest: AgentManifest;
  readonly server: McpServerManifest;
}

/** Servers of the root agent, then of each agent it uses as a tool. */
export function serversOf(manifest: AgentManifest): DeclaredServer[] {
  const servers: DeclaredServer[] = [];
  const add = (agent: AgentManifest, agentId?: string) => {
    for (const server of Object.values(agent.mcpServers ?? {}))
      servers.push({ ...(agentId === undefined ? {} : { agentId }), manifest: agent, server });
  };
  add(manifest);
  for (const child of delegatesOf(manifest)) add(child.manifest, child.manifest.id);
  return servers;
}

export function findServer(
  manifest: AgentManifest,
  agentId: string | undefined,
  serverName: string,
): DeclaredServer | undefined {
  return serversOf(manifest).find(
    (item) => item.agentId === agentId && item.server.name === serverName,
  );
}

function ownerOf(declared: DeclaredServer): { agentId?: string } {
  return declared.agentId === undefined ? {} : { agentId: declared.agentId };
}

function owned<T extends object>(declared: DeclaredServer, value: T): T {
  return { ...ownerOf(declared), ...value };
}
