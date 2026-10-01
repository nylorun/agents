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
 * Opens a connection pool for Session Stores and the Tenant catalog. One pool
 * serves every Tenant schema of a Host; stores never end it, so the caller
 * calls `client.end()` at shutdown. This module and its siblings are the only
 * code that imports the Postgres driver (seam rule 3).
 *
 * Statements are not prepared (`prepare: false`). Every statement names its
 * Tenant's schema, so the same query is a different statement per Tenant, and
 * named prepared statements would pile up on every pooled connection with the
 * number of Tenants a Host serves. Unnamed statements still go in one round
 * trip; the queries are simple enough that re-planning them costs little.
 *
 * The pool is shared by every Tenant, so a statement or transaction that hangs must not hold
 * a connection forever: both are bounded by default.
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
