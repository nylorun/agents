/**
 * Remote MCP servers in the gates service (F4.1): the gate holds each session's connection to a
 * declared `streamable-http` or `sse` server, authorizes it with the Tenant vault and runs
 * `tools/list` and `tools/call` on it. The loop names the server; the gate
 * finds it in the session's pinned manifest, so the loop never chooses a URL or a credential.
 *
 * A failure is an answer (`{ok: false, error}`), shaped so the loop's diagnostics read it as
 * they read a failure in their own process; a tool call's failure is coded (R2b C7). A call's
 * result and failure carry no credential value sent for it (`sdkClient`, C8), so neither does
 * its `tool_crossings` row. Logs one line per call, never arguments, results or credentials.
 */
import type { McpServerManifest } from "@nylorun/core/define";
import {
  McpCallFailed,
  McpConnectionStale,
  openMcpServer,
  unreachable,
  type LiveConnection,
  type McpToolPage,
} from "../mcp/connect.js";
import { findServer, type McpServerRef } from "../mcp/pool.js";
import type { OutboundPolicy } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import type { McpAnswer, McpGateError } from "./tool-contract.js";
import { GateRefusal, type TenantVault, type TenantVaults } from "./tenant-vaults.js";

/** A connection unused this long is closed; the next request opens it again. */
export const GATE_MCP_IDLE_MS = 15 * 60_000;

export interface McpHandlerOptions {
  readonly vaults: TenantVaults;
  readonly logger: Logger;
  /** Default `GATE_MCP_IDLE_MS`. */
  readonly idleMs?: number;
  readonly now?: () => number;
  /** Tests replace how a server is opened. */
  readonly open?: typeof openMcpServer;
  /** How the gate reaches remote servers (`NYLORUN_ENDPOINT_*`). Default: no limits. */
  readonly delivery?: OutboundPolicy;
}

export interface McpHandler {
  connect(tenantId: string | undefined, server: McpServerRef): Promise<McpAnswer<null>>;
  list(
    tenantId: string | undefined,
    server: McpServerRef,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<McpAnswer<McpToolPage>>;
  /** One `tools/call`; the raw `CallToolResult` on success. */
  call(
    tenantId: string | undefined,
    request: { server: McpServerRef; effectId: string; name: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<McpAnswer<Record<string, unknown>>>;
  close(server: McpServerRef): Promise<void>;
  /** Closes connections idle past the timeout. */
  sweep(): Promise<void>;
  /** Closes every connection (gateway shutdown). */
  closeAll(): Promise<void>;
  /** Open connections (tests). */
  readonly size: number;
}

interface Live {
  readonly connection: LiveConnection;
  lastUsedAt: number;
  active: number;
  /** Out of the map (`McpConnectionStale`): closed when its last request ends. */
  evicted?: boolean;
}

/** The server is not one the session may reach through the gate. */
class NotDeclared extends Error {}

export function createMcpHandler(options: McpHandlerOptions): McpHandler {
  const { vaults, logger } = options;
  const idleMs = options.idleMs ?? GATE_MCP_IDLE_MS;
  const now = options.now ?? Date.now;
  const open = options.open ?? openMcpServer;
  const live = new Map<string, Live>();
  const opening = new Map<string, Promise<Live>>();

  const keyOf = (server: McpServerRef) =>
    JSON.stringify([server.sessionId, server.agentId ?? null, server.capabilityId, server.serverName]);

  /** The declared remote server, from the session's pinned manifest. */
  async function declared(
    vault: TenantVault,
    server: McpServerRef,
  ): Promise<McpServerManifest> {
    const session = await vault.session(server.sessionId);
    if (!session) throw new NotDeclared(`Session ${server.sessionId} not found`);
    const found = findServer(session.manifest, server.agentId, server.capabilityId, server.serverName);
    if (!found) throw new NotDeclared(`MCP server '${server.serverName}' is not declared`);
    return found.server;
  }

  async function connection(tenantId: string | undefined, server: McpServerRef): Promise<Live> {
    const key = keyOf(server);
    const existing = live.get(key);
    if (existing) return existing;
    let pending = opening.get(key);
    if (!pending) {
      pending = (async () => {
        const vault = await vaults.open(tenantId);
        const manifest = await declared(vault, server);
        const connection = await open({
          server: manifest,
          authorize: (url) =>
            vault.authorizeMcp(server.sessionId, {
              url,
              serverName: server.serverName,
              ...(server.agentId === undefined ? {} : { agentId: server.agentId }),
            }),
          policy: options.delivery ?? {},
        });
        const entry: Live = { connection, lastUsedAt: now(), active: 0 };
        live.set(key, entry);
        return entry;
      })().finally(() => opening.delete(key));
      opening.set(key, pending);
    }
    return pending;
  }

  async function answer<T>(
    what: string,
    server: McpServerRef,
    run: () => Promise<T>,
    extra: Record<string, unknown> = {},
  ): Promise<McpAnswer<T>> {
    const started = now();
    try {
      const result = await run();
      logger.info("mcp_request", { what, ...fields(server), ...extra, ms: now() - started, outcome: "ok" });
      return { ok: true, result };
    } catch (error) {
      const failed = errorOf(error);
      logger.info("mcp_request", {
        what,
        ...fields(server),
        ...extra,
        ms: now() - started,
        outcome: failed.failure?.code ?? (failed.code === undefined ? "failed" : String(failed.code)),
      });
      return { ok: false, error: failed };
    }
  }

  /** The server's connection; for a tool call, one that cannot be opened is `mcp.unreachable`. */
  async function opened(tenantId: string | undefined, server: McpServerRef, call: boolean): Promise<Live> {
    try {
      return await connection(tenantId, server);
    } catch (error) {
      // The call was never sent, so the model may try again (R2b C7). A gate that cannot serve
      // the session is not the server's failure, and stays as it was.
      if (!call || error instanceof GateRefusal || error instanceof NotDeclared) throw error;
      throw unreachable(server.serverName, error);
    }
  }

  async function use<T>(
    tenantId: string | undefined,
    server: McpServerRef,
    run: (entry: Live) => Promise<T>,
    call = false,
  ): Promise<T> {
    const entry = await opened(tenantId, server, call);
    entry.active += 1;
    try {
      return await run(entry);
    } catch (error) {
      // The connection can no longer make requests: the next one opens a new connection, and
      // the calls still running on this one finish first (the last closes it).
      if (error instanceof McpConnectionStale) {
        const key = keyOf(server);
        if (live.get(key) === entry) live.delete(key);
        entry.evicted = true;
      }
      throw error;
    } finally {
      entry.active -= 1;
      entry.lastUsedAt = now();
      if (entry.evicted && entry.active === 0) void entry.connection.close().catch(() => {});
    }
  }

  /**
   * One `tools/call`. A connection found stale before the tool saw the call is opened again, and
   * the call sent once more (R2b C7).
   */
  async function callOnce(
    tenantId: string | undefined,
    request: { server: McpServerRef; name: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await use(
          tenantId,
          request.server,
          (entry) =>
            entry.connection.client.callTool({ name: request.name, arguments: request.arguments }, { signal }),
          true,
        );
      } catch (error) {
        if (!(error instanceof McpConnectionStale) || attempt > 0) throw error;
      }
    }
  }

  return {
    connect: (tenantId, server) =>
      answer("connect", server, async () => {
        await connection(tenantId, server);
        return null;
      }),
    list: (tenantId, server, cursor, signal) =>
      answer("list", server, () =>
        use(tenantId, server, (entry) =>
          entry.connection.client.listTools(cursor ? { cursor } : undefined, { signal }),
        ),
      ),
    async call(tenantId, request, signal) {
      const answered = await answer("call", request.server, () => callOnce(tenantId, request, signal), {
        effect: request.effectId,
      });
      if (!answered.ok) return answered;
      const { result, redacted } = answered.result;
      return { ok: true, result, ...(redacted ? { redacted } : {}) };
    },
    async close(server) {
      const key = keyOf(server);
      const entry = live.get(key);
      if (!entry) return;
      live.delete(key);
      await entry.connection.close().catch(() => {});
    },
    async sweep() {
      const cutoff = now() - idleMs;
      const idle: Live[] = [];
      for (const [key, entry] of live) {
        if (entry.active > 0 || entry.lastUsedAt > cutoff) continue;
        live.delete(key);
        idle.push(entry);
      }
      await Promise.all(idle.map((entry) => entry.connection.close().catch(() => {})));
    },
    async closeAll() {
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((entry) => entry.connection.close().catch(() => {})));
    },
    get size() {
      return live.size;
    },
  };
}

function fields(server: McpServerRef) {
  return {
    session: server.sessionId,
    capability: server.capabilityId,
    server: server.serverName,
    ...(server.agentId === undefined ? {} : { agent: server.agentId }),
  };
}

/** An error as the loop's `diagnosticFromError` reads it, with a coded failure's code (R2b C7). */
function errorOf(error: unknown): McpGateError {
  if (error instanceof GateRefusal) return { message: error.outcome.message };
  if (error instanceof McpCallFailed)
    return {
      message: error.message,
      ...(error.code === "credential_rejected" ? { code: 401 } : {}),
      failure: error.failure,
    };
  const message = error instanceof Error ? error.message.slice(0, 2000) : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : undefined;
  const credentialIds =
    error && typeof error === "object" && "credentialIds" in error
      ? (error as { credentialIds?: readonly string[] }).credentialIds
      : undefined;
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(credentialIds === undefined ? {} : { credentialIds: [...credentialIds] }),
  };
}
