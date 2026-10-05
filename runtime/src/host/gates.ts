/**
 * The gates service's process (blueprint §15, §19): one listener serving the Model Gate's and
 * the Tool Gate's routes (`api/gate/routes.ts`), behind the same `Host` check as the Runtime's
 * listeners.
 * It opens no Tenant runtime, no Restate endpoint and no stream relay, and runs no migration;
 * it needs only the Postgres pool and the Host's tenant directory (read-only). Run tokens (F5)
 * verify against the Tenant's public keys and session rows in that database.
 *
 * Nothing is written while a model call runs, so the server's request timeout sits above the
 * gate's longest call. Closing stops accepting calls, lets running ones finish for up to
 * `drainMs`, then aborts them (their providers' requests with them).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createGatesApp } from "../api/gate/routes.js";
import { createModelCallHandler } from "../gates/handler.js";
import { createInflightCalls, type InflightCallsOptions } from "../gates/inflight.js";
import { createMcpHandler, GATE_MCP_IDLE_MS } from "../gates/mcp-handler.js";
import { createToolCalls } from "../gates/tool-calls.js";
import type { openMcpServer } from "../mcp/connect.js";
import type { OutboundPolicy } from "../tenant/outbound.js";
import { existsSync } from "node:fs";
import { tenantPaths } from "../tenant/paths.js";
import { staleRun, verifyRunToken, type RunTokenKeyCache } from "../tenant/run-token.js";
import { createFsBlobStore, type BlobStore } from "../blob/index.js";
import type { ModelCallSettings } from "../gates/model-gate.js";
import { createTenantVaults, type TenantVaults } from "../gates/tenant-vaults.js";
import { probeDatabase } from "../infra/database.js";
import type { PostgresClient } from "../store/postgres/connect.js";
import type { Logger } from "../tenant/types.js";
import { bindListener, headerValue, isAllowedRequestHost, sendRejected } from "./http.js";
import type { EgressConfig, GatesConfig } from "./stack-config.js";
import { startEgressGate, storeEgressSandboxes, type EgressGate, type StartEgressGateOptions } from "../gates/egress.js";
import { verifyEgressToken, type EgressTokenKeyCache } from "../sandbox/egress-token.js";

/** Above the gate's 600 s provider request timeout and the loop's 630 s client timeout. */
export const GATES_REQUEST_TIMEOUT_MS = 660_000;

export interface StartGatesOptions {
  readonly gates: GatesConfig;
  readonly logger: Logger;
  /** The Host root, for the Tenant's vault key. Required unless `vaults` is given. */
  readonly hostRoot?: string;
  /** The pool for the Tenant's vault and readiness. Required unless `vaults` is given. */
  readonly database?: PostgresClient;
  /** Replaces the Postgres-backed Tenant vault (tests). */
  readonly vaults?: TenantVaults;
  /** Retries and timeouts of model calls (tests). */
  readonly settings?: ModelCallSettings;
  /** Largest model call body (tests). */
  readonly maxBodyBytes?: number;
  /** How long `close` lets running calls finish. Default 10 s. */
  readonly drainMs?: number;
  /** How long keyed outcomes are kept, and how many (tests). */
  readonly inflight?: InflightCallsOptions;
  /** How the gate may call Action endpoints and MCP servers (`NYLORUN_ENDPOINT_*`). Default: no limits. */
  readonly delivery?: OutboundPolicy;
  /** How long an MCP connection may sit unused. Default `GATE_MCP_IDLE_MS`. */
  readonly mcpIdleMs?: number;
  /** Tests replace how a remote MCP server is opened. */
  readonly openMcp?: typeof openMcpServer;
  /**
   * Serve the keys service too (`--service gates,keys`, F4.2): vault writes and token signing
   * with the Tenant's vault key. The gateway is then not ready until the key file is there.
   */
  readonly keys?: boolean;
  /**
   * The Object store model-gate reads the files a prompt names from (protocol 6): the stack's
   * `s3` store. Without one, the Tenant's `fs` store under the Host root, when there is one.
   */
  readonly blobs?: BlobStore;
}

export interface GatesServer {
  /** Where the gate listens, e.g. `http://0.0.0.0:4100`. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startGates(options: StartGatesOptions): Promise<GatesServer> {
  const { gates, logger, database } = options;
  let vaults = options.vaults;
  if (!vaults) {
    if (!database || options.hostRoot === undefined)
      throw new Error("startGates needs the Postgres pool and the Host root");
    vaults = createTenantVaults({
      sql: database,
      hostRoot: options.hostRoot,
      ...(gates.resolver ? { resolver: gates.resolver } : {}),
      ...(options.delivery ? { delivery: options.delivery } : {}),
    });
  }
  const blobs =
    options.blobs ??
    (options.hostRoot !== undefined
      ? createFsBlobStore({ root: tenantPaths(options.hostRoot).blobs })
      : undefined);
  const inflight = createInflightCalls(options.inflight);
  const mcpIdleMs = options.mcpIdleMs ?? GATE_MCP_IDLE_MS;
  const mcp = createMcpHandler({
    vaults,
    logger,
    idleMs: mcpIdleMs,
    ...(options.openMcp ? { open: options.openMcp } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
  });
  const toolCalls = createToolCalls({
    vaults,
    mcp,
    logger,
    ...(options.inflight ? { inflight: options.inflight } : {}),
  });
  const sweep = setInterval(() => void mcp.sweep(), Math.max(1_000, Math.min(mcpIdleMs, 60_000)));
  sweep.unref();
  const prune = setInterval(() => void toolCalls.prune(), 60 * 60_000);
  prune.unref();
  // Run tokens verify against the Tenant's public keys and session rows (F5): the same
  // database the ledger and `tool_crossings` use.
  const publicKeys: RunTokenKeyCache = new Map();
  const app = createGatesApp({
    token: gates.token,
    runs: {
      async verify(raw) {
        const vault = await vaults.open();
        return verifyRunToken(vault.store, vault.tenantId, raw, publicKeys);
      },
      stale: async (claims) => staleRun((await vaults.open()).store, claims),
    },
    inflight,
    modelGate: createModelCallHandler({
      vaults,
      logger,
      ...(options.settings ? { settings: options.settings } : {}),
      ...(blobs ? { blobs } : {}),
    }),
    ready: async () => {
      // The keys service needs the vault key, which `nylorun start` writes; it never creates one.
      if (options.keys && options.hostRoot !== undefined && !existsSync(tenantPaths(options.hostRoot).kek))
        return false;
      if (!database) return true;
      try {
        await probeDatabase(database, AbortSignal.timeout(2000));
        return true;
      } catch {
        return false;
      }
    },
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    mcp,
    toolCalls,
    delivery: options.delivery ?? {},
    logger,
    ...(options.keys ? { keys: async () => (await vaults.open()).keys() } : {}),
  });
  const listener = getRequestListener(app.fetch);
  const inFlight = new Set<ServerResponse>();
  // The configured Host values, plus the loopback forms of the port actually bound (probes
  // from inside the container; port 0 in tests).
  let allowedHosts = gates.listen.allowedHosts;
  const server = createServer((req, res) => {
    if (
      !isAllowedRequestHost(headerValue(req, "host"), {
        port: gates.listen.port,
        host: gates.listen.host,
        allowedHosts,
      })
    )
      return sendRejected(res, 421, "host_rejected", "Host header is not an allowed address of the gateway");
    inFlight.add(res);
    res.once("close", () => inFlight.delete(res));
    void listener(req, res);
  });
  server.requestTimeout = GATES_REQUEST_TIMEOUT_MS;
  await bindListener(server, gates.listen.port, gates.listen.host, (error) =>
    logger.error("listener_error", { error: error.message }),
  );
  const port = (server.address() as AddressInfo).port;
  allowedHosts = [
    ...new Set([...allowedHosts, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]),
  ];
  const url = `http://${gates.listen.host.includes(":") ? `[${gates.listen.host}]` : gates.listen.host}:${port}`;

  let closing: Promise<void> | undefined;
  return {
    url,
    server,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const deadline = Date.now() + (options.drainMs ?? 10_000);
        while (inFlight.size > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        // Closing a running call's connection aborts an unkeyed one; keyed calls stop here.
        server.closeAllConnections();
        inflight.close();
        toolCalls.close();
        clearInterval(sweep);
        clearInterval(prune);
        await mcp.closeAll();
        await closed;
      })();
      return closing;
    },
  };
}

export interface StartEgressOptions {
  readonly egress: EgressConfig;
  readonly logger: Logger;
  /** The pool for the Tenant's keys and sandboxes. Required unless `vaults` is given. */
  readonly database?: PostgresClient;
  /** The Host root. Required unless `vaults` is given. */
  readonly hostRoot?: string;
  /** Replaces the Postgres-backed Tenant (tests). */
  readonly vaults?: TenantVaults;
  /** Replaces how sandboxes are read, and the gate's limits and hooks (tests). */
  readonly gate?: Partial<Omit<StartEgressGateOptions, "listen" | "logger" | "verify">>;
}

/**
 * egress-gate (`--service egress`, F7.2): pods' CONNECT proxy, verifying egress tokens against the
 * Tenant's public keys and reading its sandboxes from the same database as the gates.
 */
export async function startEgress(options: StartEgressOptions): Promise<EgressGate> {
  const { database } = options;
  let vaults = options.vaults;
  if (!vaults) {
    if (!database || options.hostRoot === undefined)
      throw new Error("startEgress needs the Postgres pool and the Host root");
    vaults = createTenantVaults({ sql: database, hostRoot: options.hostRoot });
  }
  const tenant = vaults;
  const publicKeys: EgressTokenKeyCache = new Map();
  return startEgressGate({
    listen: options.egress.listen,
    logger: options.logger,
    async verify(raw) {
      const vault = await tenant.open();
      return verifyEgressToken(vault.store, vault.tenantId, raw, publicKeys);
    },
    sandboxes: { live: async (sandboxId) => storeEgressSandboxes((await tenant.open()).store).live(sandboxId) },
    ...options.gate,
  });
}
