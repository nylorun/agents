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
}

/**
 * Opens a connection pool for Session Stores and the Tenant catalog. One pool
 * serves every Tenant schema of a Host; stores never end it, so the caller
 * calls `client.end()` at shutdown. This module and its siblings are the only
 * code that imports the Postgres driver (seam rule 3).
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
    },
  });
}
