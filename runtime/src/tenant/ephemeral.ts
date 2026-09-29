/**
 * `startEphemeralRuntime`: a private, in-process Host on port 0 with one Tenant, for tests and
 * embeds that need the Runtime's HTTP API without the Docker stack. Nothing in it is durable:
 * its Tenants live in memory (the memory Session Store and memory Durable Streams) and are gone
 * after `close()`, or in the Postgres database a test passes. Scheduling is the in-process
 * execution each Tenant starts for itself.
 *
 * It is not the temporary Tenant the smoke checks use (scripts/lib/temporary-tenant.mjs):
 * that one is created on the running stack, with the Tenant-level fixture model
 * (`model-setting.ts`), and deleted afterwards.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { newTenantId } from "@nylorun/core/compatibility";
import { hashToken, mintBearerToken } from "../core/executors.js";
import { createHost } from "../host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../host/config.js";
import { createKekFile } from "../vault/kek.js";
import { MemorySessionStore } from "../store/memory.js";
import type { SessionStore } from "../store/types.js";
import { createTenantModule } from "./module.js";
import { createMemoryTenantStore } from "./store-memory.js";
import { createPostgresTenantStore } from "./store-pg.js";
import type { PostgresClient } from "../store/postgres/connect.js";
import { MemoryStreams } from "../streams/memory.js";
import { createTenantLogger } from "./logger.js";
import { hostPaths, tenantPaths } from "./paths.js";
import { bootstrapPrincipal } from "./principals.js";
import { openTenantRuntime } from "./runtime.js";
import type {
  Logger,
  TenantConfig,
  TenantModelConfig,
  TenantStore,
} from "./types.js";

const nodeRequire = createRequire(import.meta.url);

function coreVersion(): string {
  try {
    return nodeRequire("@nylorun/core/package.json").version as string;
  } catch {
    return "unknown";
  }
}

function newHostId(): string {
  return `host_${newTenantId().slice(3)}`;
}

export interface StartEphemeralRuntimeOptions {
  /**
   * Absolute Host root for `host.json`, the admin key and each Tenant's files (vault key,
   * home, sandboxes). Caller creates any temporary directory. Session data never lands here.
   */
  hostRoot: string;
  tenantId?: string;
  name?: string;
  applicationKey?: string;
  adminKey?: string;
  principalId?: string;
  /** SHA-256 of a derived Studio key; registers principal `studio`. */
  studioCredentialHash?: string;
  /** Allowlisted baseline for childEnv (e.g. PATH). Never read from ambient here. */
  baseline?: Readonly<Record<string, string>>;
  model?: TenantModelConfig;
  sandboxBackend?: "auto" | "virtual";
  /** When true, close() leaves hostRoot on disk. */
  retainRoot?: boolean;
  /** Allow browser requests (an `Origin` with a publishable key). Default off. */
  browserAccess?: boolean;
  logger?: Logger;
  /**
   * A Postgres pool: Tenants become schemas in it (`store-pg.ts`) instead of living in memory.
   * The caller ends the pool; the schemas stay.
   */
  database?: PostgresClient;
}

export interface EphemeralRuntime {
  url: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  principalId: string;
  hostRoot: string;
  close(): Promise<void>;
}

/**
 * A Tenant store whose Tenants live in memory: one memory Session Store per Tenant, created
 * with its bootstrap principals, kept across closes and re-opens, dropped on delete.
 */
function memoryTenants(options: {
  configFor: (tenantId: string) => TenantConfig;
  streams: MemoryStreams;
  logger: Logger;
}): { store: TenantStore; close(): Promise<void> } {
  const stores = new Map<string, MemorySessionStore>();
  const inner = createMemoryTenantStore({
    configFor: options.configFor,
    logger: options.logger,
    openRuntime: async (config) => {
      const store = stores.get(config.tenantId);
      if (!store) throw new Error(`Tenant ${config.tenantId} has no Session Store`);
      return openTenantRuntime(config, {
        createKekIfMissing: true,
        streams: options.streams,
        store: kept(store),
        envelope: await inner.readEnvelope(config.tenantId),
      });
    },
  });
  const store: TenantStore = {
    ...inner,
    async create(envelope, bootstrap) {
      const created = await inner.create(envelope, bootstrap);
      if (created === "created") {
        const sessions = new MemorySessionStore({ tenantId: envelope.id });
        await sessions.tx((t) => bootstrapPrincipal(t, bootstrap));
        stores.set(envelope.id, sessions);
      }
      return created;
    },
    async trash(id, now) {
      await inner.trash(id, now);
      await stores.get(id)?.close();
      stores.delete(id);
    },
    async removePartial(id) {
      await inner.removePartial(id);
      await stores.get(id)?.close();
      stores.delete(id);
    },
  };
  return {
    store,
    async close() {
      for (const sessions of stores.values()) await sessions.close();
      stores.clear();
    },
  };
}

/** The Tenant closes its store on close; a memory store must outlive that for a re-open. */
function kept(store: SessionStore): SessionStore {
  return {
    tenantId: store.tenantId,
    tx: (fn) => store.tx(fn),
    onCommit: (listener) => store.onCommit(listener),
    health: () => store.health(),
    close: async () => {},
  };
}

/**
 * Private Host on port 0 with one Tenant (D9 / A19). Not durable (see the module comment).
 * Exported from `@nylorun/runtime` and `@nylorun/runtime/core`.
 */
export async function startEphemeralRuntime(
  options: StartEphemeralRuntimeOptions
): Promise<EphemeralRuntime> {
  const hostRoot = options.hostRoot;
  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(paths.tenants, { recursive: true });
  mkdirSync(paths.trash, { recursive: true });

  const hostId = newHostId();
  const adminKey = options.adminKey ?? randomBytes(32).toString("hex");
  const hostConfig: HostConfigFile = {
    hostId,
    host: "127.0.0.1",
    port: 0,
  };
  const credentials: HostCredentialsFile = { adminKey };
  writeFileSync(paths.config, `${JSON.stringify(hostConfig, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    paths.credentials,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { mode: 0o600 }
  );

  const logger: Logger =
    options.logger ??
    ({
      info() {},
      warn() {},
      error() {},
    } satisfies Logger);

  const baseline = options.baseline ?? {};
  const model: TenantModelConfig =
    options.model ?? ({ kind: "scripted", output: "ok" } as const);

  const configFor = (tenantId: string): TenantConfig => {
    const tenant = tenantPaths(hostRoot, tenantId);
    // A seeded `sandbox.backend` setting overrides this when the Tenant opens.
    const sandboxBackend = options.sandboxBackend ?? ("virtual" as const);
    return {
      tenantId,
      mode: "ephemeral",
      paths: tenant,
      sandbox: { backend: sandboxBackend },
      model,
      childEnv: Object.freeze({
        ...baseline,
        HOME: tenant.home,
        TMPDIR: tenant.tmp,
      }),
      logger: createTenantLogger({
        tenantId,
        logPath: tenant.log,
      }),
    };
  };

  const streams = new MemoryStreams();
  const memory = options.database
    ? undefined
    : memoryTenants({ configFor, streams, logger });
  const store = options.database
    ? createPostgresTenantStore({
        hostRoot,
        sql: options.database,
        configFor,
        logger,
        openRuntime: (config, opened) =>
          openTenantRuntime(config, {
            createKekIfMissing: true,
            streams,
            ...opened,
          }),
      })
    : memory!.store;

  const module = createTenantModule({
    store,
    logger,
    onDeleted: (tenantId: string) => streams.deleteTenant(tenantId),
  });

  await module.start();

  const tenantId = options.tenantId ?? newTenantId();
  const applicationKey = options.applicationKey ?? mintBearerToken();
  const principalId =
    options.principalId ?? `principal_${randomBytes(8).toString("hex")}`;
  const credentialHash = hashToken(applicationKey);

  await module.create({
    tenantId,
    name: options.name ?? "ephemeral",
    principalId,
    credentialHash,
    idempotencyKey: `ephemeral-${tenantId}`,
    ...(options.studioCredentialHash
      ? { studioCredentialHash: options.studioCredentialHash }
      : {}),
  });

  // KEK for first vault write; openTenantRuntime also creates when hooks allow.
  const kekPath = tenantPaths(hostRoot, tenantId).kek;
  if (!existsSync(kekPath)) createKekFile(kekPath);
  const host = createHost({
    hostRoot,
    module,
    config: hostConfig,
    credentials,
    logger,
    coreVersion: coreVersion(),
    browserAccess: options.browserAccess === true,
  });
  await host.listen();

  let closed = false;
  return {
    url: host.url,
    tenantId,
    applicationKey,
    adminKey,
    principalId,
    hostRoot,
    async close() {
      if (closed) return;
      closed = true;
      await host.close();
      await module.close();
      await memory?.close();
      await streams.close();
      if (!options.retainRoot) rmSync(hostRoot, { recursive: true, force: true });
    },
  };
}
