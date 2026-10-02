/**
 * `startEphemeralRuntime`: a private, in-process Host on port 0 serving one Tenant, for tests
 * and embeds that need the Runtime's HTTP API without Restate and S2. Its Tenant is the one
 * the Postgres database the caller passes holds (`store/postgres/tenant.ts`), created there on
 * first start through the same path as a Host's; there is no in-memory Session Store. The rest
 * is not durable: Durable Streams are in memory and gone after `close()`, and scheduling is
 * the in-process execution the Tenant starts for itself.
 *
 * It is not the temporary Tenant the smoke checks use (scripts/lib/temporary-tenant.mjs):
 * that one is created on the running stack, with the Tenant-level fixture model
 * (`model-setting.ts`), and deleted afterwards.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { newTenantId } from "@nylorun/core/compatibility";
import { mintBearerToken } from "../core/bearer.js";
import { createHost } from "../host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../host/config.js";
import { createKekFile } from "../vault/kek.js";
import { createTenantModule } from "./module.js";
import { createPostgresTenantOpener } from "./store-pg.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../store/postgres/connect.js";
import { MemoryStreams } from "../streams/memory.js";
import { createTenantLogger } from "./logger.js";
import { hostPaths, tenantPaths } from "./paths.js";
import { hostPrincipals } from "./principals.js";
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
   * Absolute Host root for `host.json`, the admin key and the Tenant's files (vault key,
   * home, sandboxes). Caller creates any temporary directory. Session data never lands here.
   */
  hostRoot: string;
  /** The Tenant's id when the database holds no Tenant yet. Default: a new id. */
  tenantId?: string;
  /** The Tenant's name when the database holds no Tenant yet. Default `ephemeral`. */
  name?: string;
  /** An application key for an application principal of the Tenant. Default: a new key. */
  applicationKey?: string;
  adminKey?: string;
  principalId?: string;
  /**
   * SHA-256 of the Studio key; registers principal `studio` with it. Default: the key the
   * admin key derives (`deriveStudioToken` in `@nylorun/admin`).
   */
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
   * The Postgres database of the Tenant (one Tenant per database): a pool, which the caller
   * ends, or a URL, for which the Runtime opens a pool and ends it on `close()`. A database
   * that already holds a Tenant serves that one. The data stays after `close()`; a test drops
   * its database.
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
 * Private Host on port 0 serving one Tenant (D9 / A19). Durable only in its database (see the
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
    const tenant = tenantPaths(hostRoot);
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
  const applicationKey = options.applicationKey ?? mintBearerToken();
  const principalId =
    options.principalId ?? `principal_${randomBytes(8).toString("hex")}`;
  const module = createTenantModule({
    open: createPostgresTenantOpener({
      hostRoot,
      sql: ownPool ?? (options.database as PostgresClient),
      create: {
        tenantId: options.tenantId ?? newTenantId(),
        name: options.name ?? "ephemeral",
        principals: hostPrincipals({
          adminKey,
          application: { principalId, key: applicationKey },
          ...(options.studioCredentialHash
            ? { studioCredentialHash: options.studioCredentialHash }
            : {}),
        }),
      },
      configFor,
      logger,
      openRuntime: (config, opened) =>
        openTenantRuntime(config, {
          createKekIfMissing: true,
          streams,
          ...opened,
        }),
    }),
    logger,
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
  try {
    // KEK for first vault write; openTenantRuntime also creates when hooks allow.
    const kekPath = tenantPaths(hostRoot).kek;
    mkdirSync(tenantPaths(hostRoot).root, { recursive: true, mode: 0o700 });
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
    // Opens the Tenant: creates it in the database first when it holds none.
    await host.listen();
    const tenant = module.tenant();
    if (tenant.state !== "open" || !tenant.id)
      throw new Error(
        tenant.cause
          ? `The Tenant could not be opened (${tenant.cause.code}): ${tenant.cause.message}`
          : "The Tenant could not be opened: its database is unavailable",
      );
    tenantId = tenant.id;
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
