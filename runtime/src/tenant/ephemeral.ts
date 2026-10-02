/**
 * `startEphemeralRuntime`: a private, in-process Host on port 0 with one Tenant, for tests and
 * embeds that need the Runtime's HTTP API without Restate and S2. Its Tenants are schemas
 * in the Postgres database the caller passes (`store-pg.ts`); there is no in-memory Session
 * Store. The rest is not durable: Durable Streams are in memory and gone after `close()`, and
 * scheduling is the in-process execution each Tenant starts for itself.
 *
 * It is not the temporary Tenant the smoke checks use (scripts/lib/temporary-tenant.mjs):
 * that one is created on the running stack, with the Tenant-level fixture model
 * (`model-setting.ts`), and deleted afterwards.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { newTenantId } from "@nylorun/core/compatibility";
import { hashToken, mintBearerToken } from "../core/bearer.js";
import { createHost } from "../host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../host/config.js";
import { createKekFile } from "../vault/kek.js";
import { createTenantModule } from "./module.js";
import { createPostgresTenantStore } from "./store-pg.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../store/postgres/connect.js";
import { MemoryStreams } from "../streams/memory.js";
import { createTenantLogger } from "./logger.js";
import { hostPaths, tenantPaths } from "./paths.js";
import { openTenantRuntime } from "./runtime.js";
import type { Logger, TenantConfig, TenantModelConfig } from "./types.js";

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
  /** Serve the Admin API on its own loopback listener (`adminUrl`). Default off. */
  operatorListener?: boolean;
  logger?: Logger;
  /**
   * The Postgres database the Tenants live in, as schemas (`store-pg.ts`): a pool, which the
   * caller ends, or a URL, for which the Runtime opens a pool and ends it on `close()`. The
   * schemas stay after `close()`; a test drops its database.
   */
  database: PostgresClient | string;
}

export interface EphemeralRuntime {
  url: string;
  /** Where the Admin API answers: `url`, or the operator listener when requested. */
  adminUrl: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  principalId: string;
  hostRoot: string;
  close(): Promise<void>;
}

/**
 * Private Host on port 0 with one Tenant (D9 / A19). Durable only in its database (see the
 * module comment).
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
  const ownPool =
    typeof options.database === "string"
      ? createPostgresClient(options.database)
      : undefined;
  const store = createPostgresTenantStore({
    hostRoot,
    sql: ownPool ?? (options.database as PostgresClient),
    configFor,
    logger,
    openRuntime: (config, opened) =>
      openTenantRuntime(config, {
        createKekIfMissing: true,
        streams,
        ...opened,
      }),
  });

  const module = createTenantModule({
    store,
    logger,
    onDeleted: (tenantId: string) => streams.deleteTenant(tenantId),
  });

  let host: ReturnType<typeof createHost> | undefined;
  /** Closes what was opened, in reverse order; `close()` and a failed start share it. */
  const release = async () => {
    await host?.close();
    await module.close();
    await streams.close();
    await ownPool?.end({ timeout: 5 });
    if (!options.retainRoot) rmSync(hostRoot, { recursive: true, force: true });
  };

  let tenantId: string;
  let applicationKey: string;
  let principalId: string;
  try {
    await module.start();

    tenantId = options.tenantId ?? newTenantId();
    applicationKey = options.applicationKey ?? mintBearerToken();
    principalId =
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
    host = createHost({
      hostRoot,
      module,
      config: hostConfig,
      credentials,
      logger,
      coreVersion: coreVersion(),
      browserAccess: options.browserAccess === true,
      ...(options.operatorListener
        ? { operator: { host: "127.0.0.1", port: 0 } }
        : {}),
    });
    await host.listen();
  } catch (error) {
    await release().catch((cleanup: unknown) =>
      logger.warn("ephemeral runtime cleanup failed", {
        message: cleanup instanceof Error ? cleanup.message : String(cleanup),
      })
    );
    throw error;
  }

  const started = host;
  let closed = false;
  return {
    url: started.url,
    adminUrl: started.adminUrl,
    tenantId,
    applicationKey,
    adminKey,
    principalId,
    hostRoot,
    async close() {
      if (closed) return;
      closed = true;
      await release();
    },
  };
}
