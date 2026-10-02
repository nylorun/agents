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
   * 60 s; 0 turns it off. Schema migrations lift it (`lockSchema`).
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
 * (seam rule 3).
 *
 * Statements are not prepared (`prepare: false`), as when each Tenant was a schema of a
 * shared database. With one Tenant per database every statement is the same for the whole
 * pool, so prepared statements come back with the Drizzle port (session-store.md §2, F3).
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
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: options.applicationName ?? "nylorun-runtime",
      statement_timeout: options.statementTimeoutMs ?? 60_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
    },
  });
}
