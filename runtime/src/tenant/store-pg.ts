/**
 * The Tenant store over the Postgres Tenant catalog (architecture §8.1, §8.2).
 *
 * A Tenant exists when its schema `tenant_<id>` exists (`store/postgres/tenants.ts`); the
 * envelope is a row in it, so this store keeps no registry. What stays on the Host root is
 * the Tenant directory `tenants/<id>/`: the vault key (`vault-kek`), `plugin-data/`, `logs/`,
 * and the private `home/`, `tmp/` and `sandboxes/`. It is created with the Tenant and removed
 * with it; nothing in it says whether the Tenant exists.
 *
 * - `create` makes the directory, then creates, migrates and bootstraps the schema in one
 *   transaction. A schema that already exists is `exists`; the module compares its bootstrap.
 * - `open` migrates an older schema forward and opens the Tenant Runtime on the schema's
 *   Session Store. A missing schema is `TenantNotFoundError`; a schema newer than this
 *   Runtime, a failed migration, an unreadable envelope or vault ciphertext without its key
 *   throws that quarantine. A failure outside the Tenant (Postgres unreachable, its sweep
 *   not armed) is `TenantUnavailableError`, which the module does not cache.
 * - `trash` drops the schema and removes the directory. There is no `trash/` copy: the key
 *   is useless without the schema.
 */
import { mkdirSync, rmSync } from "node:fs";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import type { PostgresClient } from "../store/postgres/connect.js";
import type { Migration } from "../store/postgres/migrations/index.js";
import { tenantSchemaName } from "../store/postgres/names.js";
import { createPostgresTenantCatalog } from "../store/postgres/tenants.js";
import { tenantPaths } from "./paths.js";
import { QuarantineError, TenantConflictError } from "./quarantine.js";
import {
  TenantNotFoundError,
  TenantUnavailableError,
  type Logger,
  type OpenTenantRuntime,
  type Quarantine,
  type TenantConfig,
  type TenantStore,
} from "./types.js";

export interface PostgresTenantStoreOptions {
  hostRoot: string;
  /** The Host's pool. The store never ends it. */
  sql: PostgresClient;
  /** Opens the Tenant Runtime on a store the catalog opened; the Runtime then owns it. */
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger?: Logger;
  /** Tests only: the migrations this Runtime knows. */
  migrations?: readonly Migration[];
}

/** Repair instructions for a Postgres Tenant, naming its schema. */
function repairFor(code: Quarantine["code"], tenantId: string): string {
  const status = `nylorun tenant status ${tenantId}`;
  const schema = tenantSchemaName(tenantId);
  switch (code) {
    case "schema-too-new":
      return `${status} — schema ${schema} was migrated by a newer Runtime; run that version or newer`;
    case "migration-failed":
      return `${status} — inspect the Runtime log for the failed migration of ${schema}, fix it, then restart the Runtime`;
    case "envelope-invalid":
      return `${status} — the tenant table of schema ${schema} is missing or invalid; restore the schema from a Postgres backup`;
    case "kek-missing":
      return `${status} — restore vault-kek under the Tenant directory (ciphertext cannot be opened without it)`;
    default:
      return `${status} — inspect the Runtime log and Postgres, then restart the Runtime`;
  }
}

function unavailable(tenantId: string, cause: unknown): TenantUnavailableError {
  return cause instanceof TenantUnavailableError
    ? cause
    : new TenantUnavailableError(tenantId, { cause });
}

function quarantined(reason: Quarantine, tenantId: string): QuarantineError {
  return new QuarantineError({ ...reason, repair: repairFor(reason.code, tenantId) });
}

export function createPostgresTenantStore(
  options: PostgresTenantStoreOptions,
): TenantStore {
  const catalog = createPostgresTenantCatalog({
    sql: options.sql,
    ...(options.migrations ? { migrations: options.migrations } : {}),
    onError: (error) =>
      options.logger?.error("post-commit step failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  const paths = (id: string) => tenantPaths(options.hostRoot, id);

  function makeDirectory(id: string): void {
    const p = paths(id);
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    for (const dir of [p.home, p.tmp, p.sandboxes, p.pluginData, p.logs])
      mkdirSync(dir, { recursive: true });
  }

  async function readEnvelope(id: string): Promise<TenantEnvelope> {
    try {
      return await catalog.readEnvelope(id);
    } catch (error) {
      if (!(error instanceof QuarantineError)) throw unavailable(id, error);
      // Dropped since it was listed (deleted by another process).
      if (!(await catalog.tenantExists(id).catch(() => true)))
        throw new TenantNotFoundError(id);
      throw quarantined(error.toQuarantine(), id);
    }
  }

  return {
    enumerate: () => catalog.listTenantIds(),

    readEnvelope,

    async create(envelope, bootstrap) {
      makeDirectory(envelope.id);
      try {
        const result = await catalog.createTenant({ envelope, principals: bootstrap });
        return result.status;
      } catch (error) {
        // An existing Tenant with other bootstrap material; the module reports the conflict.
        if (error instanceof TenantConflictError) return "exists";
        throw error;
      }
    },

    bootstrapMatches: (id, bootstrap) => catalog.bootstrapMatches(id, bootstrap),

    async open(id) {
      const result = await catalog
        .openTenant(id)
        .catch((error: unknown) => {
          throw unavailable(id, error);
        });
      if (result.status === "not-found") throw new TenantNotFoundError(id);
      if (result.status === "quarantined") throw quarantined(result.reason, id);
      if (result.migrated.from !== result.migrated.to)
        options.logger?.info("tenant schema migrated", {
          tenantId: id,
          from: result.migrated.from,
          to: result.migrated.to,
        });
      try {
        makeDirectory(id);
        const config = options.configFor(id);
        return await options.openRuntime(
          { ...config, tenantId: id },
          { store: result.store, envelope: result.envelope },
        );
      } catch (error) {
        await result.store.close().catch(() => undefined);
        // The Runtime's own quarantines (`kek-missing`) get this store's repair wording.
        const reason = (error as { quarantine?: Quarantine } | null)?.quarantine;
        if (reason) throw quarantined(reason, id);
        if (error instanceof QuarantineError) throw error;
        // Anything else failed outside the Tenant (Postgres, arming its sweep in Restate):
        // the next use tries again rather than quarantining it.
        throw unavailable(id, error);
      }
    },

    async trash(id) {
      await catalog.deleteTenant(id);
      rmSync(paths(id).root, { recursive: true, force: true });
    },

    async removePartial(id) {
      if (await catalog.tenantExists(id)) return;
      rmSync(paths(id).root, { recursive: true, force: true });
    },
  };
}
