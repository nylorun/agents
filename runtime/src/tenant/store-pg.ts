/**
 * Opens the Host's Tenant on its Postgres database (tenancy.md §4–§5, plan P9).
 *
 * The database holds one Tenant (`store/postgres/tenant.ts`): opening migrates it, creates
 * the Tenant on first start (from the Host's configuration: id, name, Studio and derived
 * principals), and opens the Tenant Runtime on its Session Store. What stays on the Host root
 * is the Tenant directory `tenant/`: the vault key (`vault-kek`), `plugin-data/`, `logs/`,
 * and the private `home/`, `tmp/` and `sandboxes/`.
 *
 * - A failure in the Tenant (an old layout, a database newer than this Runtime, a failed
 *   migration, an unreadable Tenant row, vault ciphertext without its key) rejects with that
 *   `TenantOpenError`; the Host reports it and fails readiness.
 * - A failure outside the Tenant (Postgres unreachable, its sweep not armed in Restate) is
 *   `TenantUnavailableError`; the Tenant module retries.
 */

import { createPostgresReadStore } from "../store/postgres/reads.js";
import { mkdirSync } from "node:fs";
import type { PostgresClient } from "../store/postgres/connect.js";
import type { Migration } from "../store/postgres/migrate.js";
import {
  openTenantDatabase,
  type TenantCreation,
} from "../store/postgres/tenant.js";
import { TenantOpenError } from "./cause.js";
import { tenantPaths } from "./paths.js";
import {
  TenantUnavailableError,
  type Logger,
  type OpenTenantRuntime,
  type TenantConfig,
  type TenantOpener,
} from "./types.js";

export interface PostgresTenantOptions {
  hostRoot: string;
  /** The pool on the Tenant's database. The Tenant never ends it. */
  sql: PostgresClient;
  /** Who the Tenant is when the database holds none yet. */
  create: TenantCreation;
  /** Opens the Tenant Runtime on the opened store; the Runtime then owns it. */
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger?: Logger;
  /** Tests only: the migrations this Runtime knows. */
  migrations?: readonly Migration[];
}

function unavailable(cause: unknown): TenantUnavailableError {
  return cause instanceof TenantUnavailableError
    ? cause
    : new TenantUnavailableError({ cause });
}

export function createPostgresTenantOpener(options: PostgresTenantOptions): TenantOpener {
  const { logger } = options;
  return async () => {
    const opened = await openTenantDatabase({
      sql: options.sql,
      create: options.create,
      ...(options.migrations ? { migrations: options.migrations } : {}),
      onError: (error) =>
        logger?.error("post-commit step failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
    }).catch((error: unknown) => {
      if (error instanceof TenantOpenError) throw error;
      throw unavailable(error);
    });
    const { store, envelope } = opened;
    const tenantId = envelope.id;
    if (opened.created) logger?.info("tenant created", { tenantId, name: envelope.name });
    else if (options.create.tenantId !== undefined && options.create.tenantId !== tenantId)
      logger?.warn("tenant id configured differs", {
        tenantId,
        configured: options.create.tenantId,
        message: "The database already holds a Tenant; the configured id applies only to a new database",
      });
    if (opened.migrated.from !== opened.migrated.to)
      logger?.info("tenant schema migrated", {
        tenantId,
        from: opened.migrated.from,
        to: opened.migrated.to,
      });
    let reads: ReturnType<typeof createPostgresReadStore> | undefined;
    try {
      reads = createPostgresReadStore(options.sql, tenantId);
      const config = options.configFor(tenantId);
      const paths = tenantPaths(options.hostRoot);
      mkdirSync(paths.root, { recursive: true, mode: 0o700 });
      return await options.openRuntime({ ...config, tenantId }, { store, envelope, reads });
    } catch (error) {
      await reads?.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      if (error instanceof TenantOpenError) {
        // The Tenant's own failure (`kek-missing`): report which Tenant it is.
        error.envelope ??= envelope;
        throw error;
      }
      // Anything else failed outside the Tenant (Postgres, arming its sweep in Restate): the
      // next use tries again.
      throw unavailable(error);
    }
  };
}
