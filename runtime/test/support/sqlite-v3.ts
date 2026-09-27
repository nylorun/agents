import { withTenantDatabase } from "../../src/tenant/schema.js";

/**
 * Writes a Tenant database in the v3 layout (global event sequence, principals limited to
 * the application role), with two sessions and three events, for migration tests.
 */
export function createV3Database(path: string): void {
  withTenantDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE definitions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE commands(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE checkpoints(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE effects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sandboxes(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE links(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX events_session ON events(session_id, sequence);
      CREATE TABLE vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'user');
      CREATE UNIQUE INDEX vaults_one_host ON vaults(scope) WHERE scope = 'host';
      CREATE TABLE vault_credentials(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, binding_json TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, rotated_at TEXT, kek_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, wrapped_dek BLOB NOT NULL);
      CREATE TABLE vault_audit(id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, vault_id TEXT, credential_id TEXT, session_id TEXT, target TEXT, outcome TEXT NOT NULL);
      CREATE TABLE vault_idempotency(id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE executors(agent_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, implementation_version TEXT NOT NULL, manifest_hash TEXT, principal_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE principals(id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role = 'application'), token_hash TEXT NOT NULL UNIQUE, idempotency_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE tenant_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO principals VALUES('pr_1', 'application', 'h1', 'k', 'x');
      PRAGMA user_version = 3;
    `);
    const session = (id: string, status: string) =>
      JSON.stringify({ id, agentId: "agent-a", status, activeTurnId: null });
    const insertSession = db.prepare(
      "INSERT INTO sessions(id, body) VALUES(?, ?)"
    );
    insertSession.run("s1", session("s1", "running"));
    insertSession.run("s2", session("s2", "idle"));
    const insertEvent = db.prepare(
      "INSERT INTO events(session_id, body) VALUES(?, ?)"
    );
    for (const [sid, type] of [
      ["s1", "a"],
      ["s2", "b"],
      ["s1", "c"],
    ] as const)
      insertEvent.run(sid, JSON.stringify({ sessionId: sid, type, cursor: "old" }));
  });
}
