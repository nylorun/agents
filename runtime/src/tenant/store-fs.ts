import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isTenantId } from "@nylorun/core/compatibility";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { hostPaths, tenantPaths } from "./paths.js";
import { readEnvelopeFile, writeEnvelopeFile } from "./envelope.js";
import { migrateTenantWithSnapshot } from "./migration.js";
import { quarantine } from "./quarantine.js";
import { bootstrapPrincipal, bootstrapPrincipalMatches } from "./principals.js";
import {
  TENANT_SCHEMA_VERSION,
  migrateTenantDatabase as defaultMigrate,
  schemaVersionOf as defaultSchemaVersionOf,
  withTenantDatabase,
} from "./schema.js";
import { createSqliteSessionStore } from "../store/sqlite.js";
import type { Tx } from "../store/types.js";
import type {
  BootstrapPrincipal,
  Logger,
  OpenTenantRuntime,
  TenantConfig,
  TenantHandle,
  TenantStore,
} from "./types.js";
import type { MigrationHooks } from "./migration.js";

export interface FsTenantStoreOptions {
  hostRoot: string;
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger?: Logger;
  migration?: MigrationHooks;
  /** Writes the application principal into a fresh, migrated Tenant database, in `t`. */
  writeBootstrap?: (
    t: Tx,
    bootstrap: BootstrapPrincipal,
    now: Date,
  ) => Promise<void>;
}

function defaultWriteBootstrap(
  t: Tx,
  bootstrap: BootstrapPrincipal,
  now: Date,
): Promise<void> {
  return bootstrapPrincipal(t, bootstrap, now);
}

function assertLiveLock(lockPath: string, tenantId: string): void {
  if (!existsSync(lockPath)) return;
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    throw quarantine("corrupt", "could not read .runtime-lock", { tenantId });
  }
  const lockPid = Number(raw);
  if (!Number.isSafeInteger(lockPid) || lockPid < 1) {
    throw quarantine("locked", "invalid .runtime-lock contents", {
      tenantId,
      lockPath,
    });
  }
  try {
    process.kill(lockPid, 0);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      rmSync(lockPath, { force: true });
      return;
    }
    // EPERM: process exists but we cannot signal it — treat as live owner.
    if (err.code !== "EPERM") throw error;
  }
  throw quarantine("locked", "another process holds this Tenant lock", {
    tenantId,
    lockPath,
    lockPid,
  });
}

function trashStamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

export function createFsTenantStore(
  options: FsTenantStoreOptions,
): TenantStore {
  const host = hostPaths(options.hostRoot);
  mkdirSync(host.tenants, { recursive: true });
  mkdirSync(host.trash, { recursive: true });
  const writeBootstrap = options.writeBootstrap ?? defaultWriteBootstrap;
  const migrationHooks: MigrationHooks = {
    schemaVersionOf:
      options.migration?.schemaVersionOf ?? defaultSchemaVersionOf,
    migrateTenantDatabase:
      options.migration?.migrateTenantDatabase ?? defaultMigrate,
    targetVersion: options.migration?.targetVersion ?? TENANT_SCHEMA_VERSION,
  };

  return {
    async enumerate() {
      if (!existsSync(host.tenants)) return [];
      return readdirSync(host.tenants, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isTenantId(d.name))
        .map((d) => d.name);
    },

    async readEnvelope(id) {
      const paths = tenantPaths(options.hostRoot, id);
      return readEnvelopeFile(paths.envelope, id);
    },

    async create(envelope, bootstrap) {
      const paths = tenantPaths(options.hostRoot, envelope.id);
      if (existsSync(paths.root) || existsSync(paths.envelope)) {
        return "exists";
      }
      const now = new Date();
      try {
        mkdirSync(paths.root, { recursive: true, mode: 0o700 });
        for (const dir of [
          paths.home,
          paths.tmp,
          paths.sandboxes,
          paths.pluginData,
          paths.logs,
          paths.migration,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
        writeEnvelopeFile(paths.envelope, envelope);
        const store = createSqliteSessionStore({
          path: paths.database,
          tenantId: envelope.id,
        });
        try {
          await store.tx((t) => writeBootstrap(t, bootstrap, now));
        } finally {
          await store.close();
        }
        // Exclusive create marker for the lock file is owned by openRuntime (WS-A);
        // we only ensure the parent exists.
        return "created";
      } catch (error) {
        rmSync(paths.root, { recursive: true, force: true });
        throw error;
      }
    },

    async bootstrapMatches(id, bootstrap) {
      const paths = tenantPaths(options.hostRoot, id);
      if (!existsSync(paths.database)) return false;
      try {
        const store = createSqliteSessionStore({
          path: paths.database,
          tenantId: id,
          readOnly: true,
        });
        try {
          return await store.tx((t) => bootstrapPrincipalMatches(t, bootstrap));
        } finally {
          await store.close();
        }
      } catch {
        return false;
      }
    },

    async open(id) {
      const paths = tenantPaths(options.hostRoot, id);
      if (!existsSync(paths.root)) {
        throw quarantine("open-failed", `Tenant directory missing`, {
          tenantId: id,
        });
      }
      assertLiveLock(paths.lock, id);

      let envelope: TenantEnvelope;
      try {
        envelope = readEnvelopeFile(paths.envelope, id);
      } catch (error) {
        throw error;
      }

      if (!existsSync(paths.database)) {
        throw quarantine("corrupt", "tenant.sqlite is missing", {
          tenantId: id,
        });
      }

      // Probe schema before openRuntime so schema-too-new never mutates.
      const version = withTenantDatabase(
        paths.database,
        migrationHooks.schemaVersionOf!,
      );
      const target = migrationHooks.targetVersion ?? TENANT_SCHEMA_VERSION;
      if (version > target) {
        throw quarantine(
          "schema-too-new",
          `Tenant schema version ${version} is newer than Host ${target}`,
          { tenantId: id },
        );
      }
      if (version < target) {
        envelope = migrateTenantWithSnapshot(
          paths,
          envelope,
          migrationHooks,
        );
      }

      const config = options.configFor(id);
      return options.openRuntime({
        ...config,
        tenantId: id,
        paths: config.paths.root ? config.paths : paths,
      });
    },

    async trash(id, now) {
      const paths = tenantPaths(options.hostRoot, id);
      if (!existsSync(paths.root)) return;
      mkdirSync(host.trash, { recursive: true });
      const dest = join(host.trash, `${id}-${trashStamp(now)}`);
      renameSync(paths.root, dest);
    },

    async removePartial(id) {
      const paths = tenantPaths(options.hostRoot, id);
      if (existsSync(paths.root)) {
        rmSync(paths.root, { recursive: true, force: true });
      }
    },
  };
}

/** Claim the Tenant lock file (used by fake openRuntime in tests). */
export function claimTenantLock(lockPath: string, pid = process.pid): void {
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

export function releaseTenantLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}
