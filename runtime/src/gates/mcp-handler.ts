/**
 * Remote MCP servers in the gates service (F4.1): the gate holds each session's connection to a
 * declared `streamable-http` or `sse` server, authorizes it with the Tenant vault and runs
 * `tools/list` and `tools/call` on it. The loop names the server; the gate
 * finds it in the session's pinned manifest, so the loop never chooses a URL or a credential.
 *
 * A failure is an answer (`{ok: false, error}`), shaped so the loop's diagnostics read it as
 * they read a failure in their own process. Logs one line per call, never arguments, results or
 * credentials.
 */
import type { McpServerManifest } from "@nylorun/core/define";
import {
  CredentialRejected,
  openMcpServer,
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
        outcome: failed.credentialRejected
          ? "credential_rejected"
          : failed.code === undefined
            ? "failed"
            : String(failed.code),
      });
      return { ok: false, error: failed };
    }
  }

  async function use<T>(
    tenantId: string | undefined,
    server: McpServerRef,
    run: (entry: Live) => Promise<T>,
  ): Promise<T> {
    const entry = await connection(tenantId, server);
    entry.active += 1;
    try {
      return await run(entry);
    } finally {
      entry.active -= 1;
      entry.lastUsedAt = now();
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
    call: (tenantId, request, signal) =>
      answer(
        "call",
        request.server,
        () =>
          use(tenantId, request.server, (entry) =>
            entry.connection.client.callTool(
              { name: request.name, arguments: request.arguments },
              { signal },
            ),
          ),
        { effect: request.effectId },
      ),
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

/** An error as the loop's `diagnosticFromError` reads it. */
function errorOf(error: unknown): McpGateError {
  if (error instanceof GateRefusal) return { message: error.outcome.message };
  if (error instanceof CredentialRejected)
    return {
      message: error.message,
      code: 401,
      credentialRejected: {
        server: error.server,
        ...(error.vault === undefined ? {} : { vault: error.vault }),
      },
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
