import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  TENANT_SCHEMA_VERSION,
  checkpointTenantDatabase,
  migrateTenantDatabase as defaultMigrate,
  schemaVersionOf as defaultSchemaVersionOf,
  withTenantDatabase,
  type TenantDatabase,
} from "./schema.js";
import { writeEnvelopeFile } from "./envelope.js";
import { quarantine } from "./quarantine.js";
import type { TenantPaths } from "./types.js";
import type { TenantEnvelope } from "@nylorun/core/contracts";

export interface MigrationHooks {
  schemaVersionOf?: (db: TenantDatabase) => number;
  /** Runs its own transaction; the caller never holds one on `db`. */
  migrateTenantDatabase?: (
    db: TenantDatabase,
  ) => { from: number; to: number };
  targetVersion?: number;
}

function stamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

function copyIfPresent(from: string, to: string): void {
  if (existsSync(from)) copyFileSync(from, to);
}

/**
 * Checkpoint WAL, snapshot database + envelope + KEK, migrate, update envelope.
 * On failure restore the snapshot, keep diagnostics, and throw migration-failed.
 */
export function migrateTenantWithSnapshot(
  paths: TenantPaths,
  envelope: TenantEnvelope,
  hooks: MigrationHooks = {},
  now = new Date(),
): TenantEnvelope {
  const schemaVersionOf = hooks.schemaVersionOf ?? defaultSchemaVersionOf;
  const migrateTenantDatabase =
    hooks.migrateTenantDatabase ?? defaultMigrate;
  const target = hooks.targetVersion ?? TENANT_SCHEMA_VERSION;

  const from = withTenantDatabase(paths.database, schemaVersionOf);

  if (from > target) {
    throw quarantine(
      "schema-too-new",
      `Tenant schema version ${from} is newer than Host ${target}`,
      { tenantId: envelope.id },
    );
  }

  if (from === target) return envelope;

  const dirName = `${from}-${target}-${stamp(now)}`;
  mkdirSync(paths.migration, { recursive: true });
  const snapshotDir = join(paths.migration, dirName);
  mkdirSync(snapshotDir, { recursive: true });

  try {
    // Checkpoint WAL so the database file is self-contained (invariant 7).
    checkpointTenantDatabase(paths.database);

    copyIfPresent(paths.database, join(snapshotDir, "tenant.sqlite"));
    copyIfPresent(paths.envelope, join(snapshotDir, "tenant.json"));
    copyIfPresent(paths.kek, join(snapshotDir, "vault-kek"));
    // Side-car WAL/SHM if present.
    copyIfPresent(
      `${paths.database}-wal`,
      join(snapshotDir, "tenant.sqlite-wal"),
    );
    copyIfPresent(
      `${paths.database}-shm`,
      join(snapshotDir, "tenant.sqlite-shm"),
    );

    // The migration runs its own transaction (no outer BEGIN: SQLite cannot nest them).
    const result = withTenantDatabase(paths.database, migrateTenantDatabase);

    const updated: TenantEnvelope = {
      ...envelope,
      schemaVersion: result.to,
      updatedAt: now.toISOString(),
    };
    writeEnvelopeFile(paths.envelope, updated);
    return updated;
  } catch (error) {
    restoreSnapshot(paths, snapshotDir);
    writeFileSync(
      join(snapshotDir, "failure.json"),
      `${JSON.stringify(
        {
          at: now.toISOString(),
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    throw quarantine(
      "migration-failed",
      error instanceof Error ? error.message : "migration failed",
      { tenantId: envelope.id, migrationPath: snapshotDir },
    );
  }
}

function restoreSnapshot(paths: TenantPaths, snapshotDir: string): void {
  const dbSnap = join(snapshotDir, "tenant.sqlite");
  const envSnap = join(snapshotDir, "tenant.json");
  const kekSnap = join(snapshotDir, "vault-kek");
  if (existsSync(dbSnap)) {
    // Replace via temp rename so a partial copy cannot leave a half file.
    const tmp = `${paths.database}.restore-tmp`;
    copyFileSync(dbSnap, tmp);
    renameSync(tmp, paths.database);
  }
  if (existsSync(envSnap)) {
    const tmp = `${paths.envelope}.restore-tmp`;
    copyFileSync(envSnap, tmp);
    renameSync(tmp, paths.envelope);
  }
  if (existsSync(kekSnap)) {
    const tmp = `${paths.kek}.restore-tmp`;
    copyFileSync(kekSnap, tmp);
    renameSync(tmp, paths.kek);
  }
  for (const side of ["-wal", "-shm"] as const) {
    const snap = join(snapshotDir, `tenant.sqlite${side}`);
    const dest = `${paths.database}${side}`;
    if (existsSync(snap)) copyFileSync(snap, dest);
    else if (existsSync(dest)) rmSync(dest, { force: true });
  }
}
