import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { newTenantId } from "@nylorun/core/compatibility";
import { hashToken, mintBearerToken } from "../core/executors.js";
import { createHost } from "../host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../host/config.js";
import { createKekFile } from "../vault/kek.js";
import { createTenantModule } from "./module.js";
import { createFsTenantStore } from "./store-fs.js";
import { bootstrapPrincipal } from "./principals.js";
import { createTenantLogger } from "./logger.js";
import { hostPaths, tenantPaths } from "./paths.js";
import { openTenantRuntime } from "./runtime.js";
import { migrateTenantDatabase, readTenantConfig } from "./schema.js";
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
  /** Absolute Host root. Caller creates any temporary directory. */
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
  logger?: Logger;
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
 * Private Host on port 0 with one Tenant (D9 / A19).
 * Exported from `@nylorun/runtime/core`.
 */
export async function startEphemeralRuntime(
  options: StartEphemeralRuntimeOptions,
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
    { mode: 0o600 },
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
    let sandboxBackend = options.sandboxBackend ?? ("virtual" as const);
    if (existsSync(tenant.database)) {
      try {
        const db = new DatabaseSync(tenant.database, { readOnly: true });
        try {
          const seeded = readTenantConfig(db).sandboxBackend;
          if (seeded) sandboxBackend = seeded;
        } finally {
          db.close();
        }
      } catch {
        /* unreadable — keep default */
      }
    }
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

  const openRuntime = (config: TenantConfig) =>
    openTenantRuntime(config, { createKekIfMissing: true });

  const store = createFsTenantStore({
    hostRoot,
    openRuntime,
    configFor,
    logger,
    writeBootstrap: (db, bootstrap) => {
      migrateTenantDatabase(db);
      bootstrapPrincipal(db, bootstrap);
    },
  });

  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger,
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
      if (!options.retainRoot) rmSync(hostRoot, { recursive: true, force: true });
    },
  };
}
