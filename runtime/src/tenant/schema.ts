import type { DatabaseSync } from "node:sqlite";

/** Tenant schema version (D4). v2 adds tenant_settings; v3 adds workflow links. */
export const TENANT_SCHEMA_VERSION = 3;

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

/**
 * Migrates a Tenant database to `TENANT_SCHEMA_VERSION`.
 * Carries vault-scope DDL as a migration step, not ad hoc (D3, D4).
 */
export function migrateTenantDatabase(db: DatabaseSync): {
  from: number;
  to: number;
} {
  const from = schemaVersionOf(db);
  if (from > TENANT_SCHEMA_VERSION) {
    throw new Error(
      `Tenant schema version ${from} is newer than Host ${TENANT_SCHEMA_VERSION}`
    );
  }
  if (from === TENANT_SCHEMA_VERSION) {
    return { from, to: from };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (from < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandboxes(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id, sequence);
        CREATE TABLE IF NOT EXISTS vaults(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'user'
        );
        CREATE INDEX IF NOT EXISTS vaults_owner ON vaults(owner_user_id);
        CREATE TABLE IF NOT EXISTS vault_credentials(
          id TEXT PRIMARY KEY,
          vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          binding_json TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          rotated_at TEXT,
          kek_id TEXT NOT NULL,
          nonce BLOB NOT NULL,
          ciphertext BLOB NOT NULL,
          wrapped_dek BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS vault_credentials_vault ON vault_credentials(vault_id);
        CREATE TABLE IF NOT EXISTS vault_audit(
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          vault_id TEXT,
          credential_id TEXT,
          session_id TEXT,
          target TEXT,
          outcome TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vault_idempotency(
          id TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          response TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS executors(
          agent_id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          implementation_version TEXT NOT NULL,
          manifest_hash TEXT,
          principal_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS principals(
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK(role = 'application'),
          token_hash TEXT NOT NULL UNIQUE,
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );
      `);
      migrateVaultScope(db);
      ensureExecutorPrincipalColumn(db);
    }
    if (from < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_settings(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
    if (from < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      `);
    }
    db.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { from, to: TENANT_SCHEMA_VERSION };
}

/** Existing vault-scope step, now owned by the Tenant migration. */
function migrateVaultScope(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(vaults)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "scope"))
    db.exec("ALTER TABLE vaults ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS vaults_one_host ON vaults(scope) WHERE scope = 'host'"
  );
}

/** Additive column for registration credential attribution (A6). */
function ensureExecutorPrincipalColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(executors)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "principal_id"))
    db.exec("ALTER TABLE executors ADD COLUMN principal_id TEXT");
}

export type SandboxBackendSetting = "auto" | "virtual";

/** Non-secret Tenant settings persisted for seed / configFor (A18). */
export function readTenantSetting(
  db: DatabaseSync,
  key: string
): string | undefined {
  const row = db
    .prepare("SELECT value FROM tenant_settings WHERE key=?")
    .get(key) as { value: string } | undefined;
  return row ? String(row.value) : undefined;
}

export function writeTenantSetting(
  db: DatabaseSync,
  key: string,
  value: string
): void {
  db.prepare(
    `INSERT INTO tenant_settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value);
}

/**
 * Read non-secret Tenant configuration from the open database.
 * Used by Host `configFor` at Integration I1.
 */
export function readTenantConfig(db: DatabaseSync): {
  sandboxBackend?: SandboxBackendSetting;
} {
  const raw = readTenantSetting(db, "sandbox.backend");
  if (raw === "auto" || raw === "virtual")
    return { sandboxBackend: raw };
  return {};
}
