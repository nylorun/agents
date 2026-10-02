import postgres, { type Sql } from "postgres";

export type PostgresClient = Sql;

export interface PostgresClientOptions {
  /** Pool size. Default 10. */
  max?: number;
  /** Seconds before an idle connection closes. Default 30. */
  idleTimeoutSeconds?: number;
  /** Seconds to wait for a connection. Default 10. */
  connectTimeoutSeconds?: number;
  /** `application_name` on every connection. Default `nylorun-runtime`. */
  applicationName?: string;
  /**
   * `statement_timeout`: a statement running or waiting for a lock longer fails. Default
   * 60 s; 0 turns it off. Migrations lift it (`lockMigrations` in `migrate.ts`).
   */
  statementTimeoutMs?: number;
  /**
   * `idle_in_transaction_session_timeout`: a transaction left idle this long is ended and its
   * connection closed, releasing its locks. Default 60 s; 0 turns it off.
   */
  idleInTransactionTimeoutMs?: number;
}

/**
 * Opens a connection pool on the Tenant's database, for its Session Store and the Tenant
 * bootstrap (`tenant.ts`). Stores never end it, so the caller calls `client.end()` at
 * shutdown. This module and its siblings are the only code that imports the Postgres driver
 * and Drizzle (seam rule 3, `scripts/check-boundaries.mjs`); Drizzle runs on this pool
 * (`db.ts`).
 *
 * Statements are prepared: one database holds one Tenant in fixed schemas, so every statement
 * is the same for the whole pool (session-store.md §2).
 *
 * The pool serves every request of the Host, so a statement or transaction that hangs must
 * not hold a connection forever: both are bounded by default.
 */
export function createPostgresClient(
  url: string,
  options: PostgresClientOptions = {},
): PostgresClient {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => {},
    connection: {
      application_name: options.applicationName ?? "nylorun-runtime",
      statement_timeout: options.statementTimeoutMs ?? 60_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
    },
  });
}

/**
 * Throws, naming the setting, when Postgres cannot run the stream relay: logical decoding
 * needs `wal_level = logical` (a restart) and a role allowed to replicate.
 */
export async function assertLogicalReplication(sql: Sql): Promise<void> {
  const [row] = await sql<{ wal_level: string; replicates: boolean }[]>`
    SELECT current_setting('wal_level') AS wal_level,
           (SELECT rolreplication OR rolsuper FROM pg_roles WHERE rolname = current_user) AS replicates`;
  if (row?.wal_level !== "logical")
    throw new Error(
      `Postgres has wal_level = ${row?.wal_level ?? "unknown"}; the stream relay needs logical replication. ` +
        "Set wal_level = logical and restart Postgres (`nylorun start` does this for the local stack; " +
        "on a managed Postgres, turn on its logical replication option). See DEPLOYMENT.md.",
    );
  if (!row.replicates)
    throw new Error(
      "The Runtime's Postgres role cannot replicate: grant it REPLICATION (ALTER ROLE … REPLICATION). See DEPLOYMENT.md.",
    );
}
