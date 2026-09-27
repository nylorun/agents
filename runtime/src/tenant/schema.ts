/**
 * The SQLite Tenant schema and its migrations. Together with the SQLite Session
 * Store (`store/sqlite.ts`), this is the only code that touches the database
 * file directly; everything else goes through `SessionStore`.
 */
import { DatabaseSync } from "node:sqlite";
import { encodeCursor } from "../store/cursor.js";

/**
 * Tenant schema version (D4). v2 adds tenant_settings; v3 adds workflow links;
 * v4 moves events to a per-session sequence (`events(session_id, seq)` with a
 * `relayed` flag that doubles as the outbox), adds `next_event_seq` and the
 * ownership columns to `sessions`, indexed generated columns for the typed
 * queries, and lets principals carry any role.
 */
export const TENANT_SCHEMA_VERSION = 4;

/** The raw database handle, for the SQLite Session Store and migrations only. */
export type TenantDatabase = DatabaseSync;

/** Opens a Tenant database with the Runtime's connection settings. */
export function openTenantDatabase(
  path: string,
  options: { readOnly?: boolean } = {}
): TenantDatabase {
  const readOnly = options.readOnly ?? false;
  const db = new DatabaseSync(path, { readOnly });
  try {
    if (!readOnly && path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Runs `fn` on a short-lived plain connection to the database file at `path`. */
export function withTenantDatabase<T>(
  path: string,
  fn: (db: TenantDatabase) => T,
  options: { readOnly?: boolean } = {}
): T {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The schema version of the database file at `path`. */
export function schemaVersionAt(path: string): number {
  return withTenantDatabase(path, schemaVersionOf, { readOnly: true });
}

/** Checkpoints the WAL so the database file is self-contained. */
export function checkpointTenantDatabase(path: string): void {
  withTenantDatabase(path, (db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
}

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

/**
 * Migrates a Tenant database to `TENANT_SCHEMA_VERSION` in one transaction of
 * its own; callers must not hold a transaction on `db`.
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
    if (from < 4) migrateToV4(db);
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

/** Adds a column unless it already exists. */
function addColumn(db: DatabaseSync, table: string, definition: string): void {
  const name = definition.split(" ")[0]!;
  const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

const generated = (name: string, path: string) =>
  `${name} TEXT GENERATED ALWAYS AS (json_extract(body, '${path}')) VIRTUAL`;

/**
 * v4: per-session event sequence, ownership columns, typed-query indexes, and
 * principals with any role. Existing events are renumbered per session (their
 * cursors change) and marked relayed: they are history, not outbox.
 */
function migrateToV4(db: DatabaseSync): void {
  addColumn(db, "sessions", "next_event_seq INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sessions", "owner TEXT");
  addColumn(db, "sessions", "epoch INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sessions", "owner_expires_at TEXT");
  addColumn(db, "sessions", generated("status", "$.status"));
  addColumn(db, "sessions", generated("agent_id", "$.agentId"));
  addColumn(db, "effects", generated("session_id", "$.request.sessionId"));
  addColumn(db, "effects", generated("turn_id", "$.request.turnId"));
  addColumn(db, "effects", generated("kind", "$.request.kind"));
  addColumn(db, "effects", generated("status", "$.status"));
  addColumn(db, "actions", generated("session_id", "$.sessionId"));
  addColumn(db, "actions", generated("turn_id", "$.turnId"));
  addColumn(db, "actions", generated("agent_id", "$.agentId"));
  addColumn(db, "actions", generated("status", "$.status"));
  addColumn(db, "actions", generated("kind", "$.kind"));
  addColumn(db, "actions", generated("lease_expires_at", "$.leaseExpiresAt"));
  addColumn(
    db,
    "links",
    generated("workflow_session_id", "$.workflowSessionId")
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status, owner_expires_at);
    CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS effects_session ON effects(session_id, turn_id, status);
    CREATE INDEX IF NOT EXISTS effects_status ON effects(status, kind);
    CREATE INDEX IF NOT EXISTS actions_session ON actions(session_id, turn_id, status);
    CREATE INDEX IF NOT EXISTS actions_agent ON actions(agent_id, status);
    CREATE INDEX IF NOT EXISTS actions_status ON actions(status, kind);
    CREATE INDEX IF NOT EXISTS actions_lease ON actions(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS links_workflow ON links(workflow_session_id);
  `);

  // Events: primary key (session_id, seq), seq from 0 per session.
  db.exec(`
    DROP TABLE IF EXISTS events_v4;
    CREATE TABLE events_v4(
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      relayed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, seq)
    ) WITHOUT ROWID;
  `);
  const insert = db.prepare(
    "INSERT INTO events_v4(session_id, seq, body, relayed) VALUES(?, ?, ?, 1)"
  );
  const next = new Map<string, number>();
  const rows = db
    .prepare("SELECT session_id, body FROM events ORDER BY sequence")
    .all() as { session_id: string; body: string }[];
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const seq = next.get(sessionId) ?? 0;
    next.set(sessionId, seq + 1);
    let body = String(row.body);
    try {
      const event = JSON.parse(body);
      event.cursor = encodeCursor(sessionId, seq);
      body = JSON.stringify(event);
    } catch {
      /* keep the body as it was */
    }
    insert.run(sessionId, seq, body);
  }
  db.exec(`
    DROP TABLE events;
    ALTER TABLE events_v4 RENAME TO events;
    CREATE INDEX IF NOT EXISTS events_outbox ON events(session_id, seq) WHERE relayed = 0;
    UPDATE sessions SET next_event_seq =
      COALESCE((SELECT MAX(seq) + 1 FROM events WHERE events.session_id = sessions.id), 0);
  `);

  // Principals: any role (the Studio principal), same columns.
  db.exec(`
    DROP TABLE IF EXISTS principals_v4;
    CREATE TABLE principals_v4(
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO principals_v4(id, role, token_hash, idempotency_key, created_at)
      SELECT id, role, token_hash, idempotency_key, created_at FROM principals;
    DROP TABLE principals;
    ALTER TABLE principals_v4 RENAME TO principals;
  `);
}
