import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_FEATURES,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { hashToken, mintBearerToken } from "../../src/core/executors.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { bootstrapPrincipal } from "../../src/tenant/principals.js";
import { createTenantLogger } from "../../src/tenant/logger.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import {
  openTenantRuntime,
  type TenantOpenHooks,
} from "../../src/tenant/runtime.js";
import { createKekFile } from "../../src/vault/kek.js";
import type { TenantConfig, TenantHandle } from "../../src/tenant/types.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import type { DurableStreams } from "../../src/streams/types.js";
import {
  TEST_STORE,
  dropTestTenant,
  testCatalog,
  testEnvelope,
  testStreams,
  withTestSessionStore,
} from "./store.js";

export type StartTestTenantOptions = Partial<TenantConfig> & {
  executors?: readonly {
    token: string;
    agentId: string;
    implementationVersion: string;
    manifestHash?: string;
  }[];
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  useHostModel?: boolean;
  /** Reuse an existing Host root (restart tests). */
  hostRoot?: string;
  applicationKey?: string;
  principalId?: string;
  /** When true, close() does not delete the Host root. */
  retainRoot?: boolean;
  /** Host-level execution and Worker id (ownership tests). */
  execution?: TenantOpenHooks["execution"];
  workerId?: string;
  /**
   * Durable Streams shared with other instances; the caller closes them. Default: this
   * Tenant's in-memory streams (`testStreams`), kept across reopens.
   */
  streams?: DurableStreams;
};

/**
 * Rewrites fields of a stored session of a closed Tenant (restart tests). `root` is the
 * Host root; the store is the one `NYLORUN_TEST_STORE` selects.
 */
export async function patchStoredSession(
  root: string,
  tenantId: string,
  sessionId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await withTestSessionStore({ root, tenantId }, (store) =>
    store.tx(async (t) => {
      const stored = await t.get("sessions", sessionId);
      if (!stored) throw new Error(`Session ${sessionId} not found`);
      await t.put("sessions", sessionId, { ...stored, ...patch });
    })
  );
}

/**
 * Minimal in-process HTTP shim over \`openTenantRuntime\` for runtime tests (§5.5). The
 * Tenant's Session Store is the one `NYLORUN_TEST_STORE` selects (`./store.ts`): a SQLite
 * file under the Host root, or a fresh Postgres schema that `close()` drops unless the root
 * is retained.
 */
export async function startTestTenant(
  options: StartTestTenantOptions = {}
): Promise<{
  url: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  principalId: string;
  headers(key?: string): Record<string, string>;
  root: string;
  handle: TenantHandle;
  close(): Promise<void>;
}> {
  const hostRoot =
    options.hostRoot ?? (await mkdtemp(join(tmpdir(), "nylorun-test-tenant-")));
  const tenantId = options.tenantId ?? newTenantId();
  const paths = options.paths ?? tenantPaths(hostRoot, tenantId);
  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.sandboxes,
    paths.pluginData,
    paths.logs,
  ])
    mkdirSync(dir, { recursive: true });

  const applicationKey = options.applicationKey ?? mintBearerToken();
  const principalId =
    options.principalId ?? `principal_${randomBytes(8).toString("hex")}`;
  const credentialHash = hashToken(applicationKey);
  const now = new Date().toISOString();

  let opened: TenantOpenHooks = {};
  if (TEST_STORE === "postgres") {
    const catalog = testCatalog();
    if (!(await catalog.tenantExists(tenantId)))
      await catalog.createTenant({
        envelope: testEnvelope(tenantId),
        principals: {
          principalId,
          credentialHash,
          idempotencyKey: `boot-${tenantId}`,
        },
      });
    const result = await catalog.openTenant(tenantId);
    if (result.status !== "ok")
      throw new Error(`Test Tenant ${tenantId} is ${result.status}`);
    opened = { store: result.store, envelope: result.envelope };
  } else if (!existsSync(paths.envelope)) {
    const envelope: TenantEnvelope = {
      id: tenantId,
      name: "test",
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    writeFileSync(paths.envelope, JSON.stringify(envelope, null, 2) + "\n");
  }

  if (TEST_STORE === "sqlite" && !existsSync(paths.database)) {
    const store = createSqliteSessionStore({ path: paths.database, tenantId });
    await store.tx((t) =>
      bootstrapPrincipal(t, {
        principalId,
        credentialHash,
        idempotencyKey: `boot-${tenantId}`,
      })
    );
    await store.close();
  }

  const mode = options.mode ?? "test";
  let model = options.model ?? { kind: "scripted" as const, output: "ok" };
  if (options.useHostModel) model = { kind: "vault" };
  if (
    (model.kind === "fixture" || model.kind === "scripted") &&
    mode === "shared"
  )
    throw new Error("fixture/scripted models require ephemeral or test mode");

  const logger =
    options.logger ?? createTenantLogger({ tenantId, logPath: paths.log });

  const childEnv = options.childEnv ?? {
    // Tests may read ambient PATH; Runtime code must not.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: paths.tmp,
  };

  const config: TenantConfig = {
    tenantId,
    mode,
    paths,
    sandbox: options.sandbox ?? { backend: "virtual" },
    model,
    childEnv,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.ownerLeaseMs === undefined
      ? {}
      : { ownerLeaseMs: options.ownerLeaseMs }),
    // A short sweep so lapsed claims and lost wakes are picked up promptly in tests.
    sweepIntervalMs: options.sweepIntervalMs ?? 50,
    ...(options.flow === undefined ? {} : { flow: options.flow }),
    ...(options.flowEnv === undefined ? {} : { flowEnv: options.flowEnv }),
    ...(options.vaultFetch === undefined
      ? {}
      : { vaultFetch: options.vaultFetch }),
    logger,
  };

  const hooks: TenantOpenHooks = {
    ...opened,
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.execution ? { execution: options.execution } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    streams: options.streams ?? testStreams(tenantId),
    createKekIfMissing: true,
  };
  if (options.vaultKek === null) {
    hooks.vaultKek = null;
  } else if (options.vaultKek !== undefined) {
    writeFileSync(
      paths.kek,
      Buffer.isBuffer(options.vaultKek)
        ? options.vaultKek.toString("base64") + "\n"
        : options.vaultKek.endsWith("\n")
        ? options.vaultKek
        : options.vaultKek + "\n",
      { mode: 0o600 }
    );
    hooks.vaultKek = options.vaultKek;
  } else if (!existsSync(paths.kek)) {
    createKekFile(paths.kek);
  }

  const handle = await openTenantRuntime(config, hooks);
  const server = createServer((req, res) => {
    // SDK Transport probes /health for protocol compatibility (Host normally serves this).
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "test",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
          coreVersion: "test",
          hostId: "host_test",
          pid: process.pid,
        })
      );
      return;
    }
    void handle.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to bind test tenant listener");
  const url = `http://127.0.0.1:${address.port}`;

  const headers = (key?: string): Record<string, string> => ({
    authorization: `Bearer ${key ?? applicationKey}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  });

  if (options.executors?.length) {
    const response = await fetch(`${url}/v1/executors`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ executors: options.executors }),
    });
    if (!response.ok)
      throw new Error(
        `Failed to seed test executors: ${
          response.status
        } ${await response.text()}`
      );
  }

  const adminKey = randomBytes(32).toString("hex");
  const retainRoot = options.retainRoot === true || !!options.hostRoot;
  return {
    url,
    tenantId,
    applicationKey,
    adminKey,
    principalId,
    headers,
    root: hostRoot,
    handle,
    async close() {
      await handle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (!retainRoot) {
        await rm(hostRoot, { recursive: true, force: true });
        await dropTestTenant(tenantId);
      }
    },
  };
}
