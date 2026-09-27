/**
 * Builds the Host's Postgres connection pool from the stack configuration
 * (architecture §12.2, §14.5). One pool serves the Tenant catalog and every
 * Tenant schema; the Host ends it at shutdown. The driver stays behind
 * `store/postgres/connect.ts`.
 */
import type { StackConfig } from "../host/stack-config.js";
import {
  createPostgresClient,
  type PostgresClient,
  type PostgresClientOptions,
} from "../store/postgres/connect.js";

export type { PostgresClient };

/** Throws when `NYLORUN_DATABASE_URL` is unset: there is no in-memory Session Store. */
export function createDatabase(
  config: Pick<StackConfig, "endpoints">,
  options: PostgresClientOptions = {},
): PostgresClient {
  const url = config.endpoints.databaseUrl;
  if (!url)
    throw new Error(
      "NYLORUN_DATABASE_URL is required: the Postgres URL of the Session Store",
    );
  return createPostgresClient(url, options);
}

/**
 * Readiness probe: resolves when `select 1` answers within `signal`'s
 * lifetime. An aborted probe cancels its query.
 */
export async function probeDatabase(
  client: PostgresClient,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const query = client`select 1 as ok`;
  const cancel = () => void query.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
