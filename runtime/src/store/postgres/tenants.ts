/**
 * The Tenant catalog on one Postgres database (architecture §8.2).
 *
 * A Tenant exists when its schema `"tenant_<id>"` exists (see `names.ts`); the
 * Host keeps no other registry. The envelope is the one row of the schema's
 * `tenant` table, and its `schemaVersion` is the schema's migrated version.
 *
 * - `createTenant` runs in one transaction: create the schema, migrate it,
 *   write the envelope and the bootstrap principals. A crash leaves nothing.
 *   Creating an existing Tenant with the same bootstrap principals returns
 *   `exists`; with different ones it throws `TenantConflictError`.
 * - `openTenant` migrates an older schema forward and returns its store. A
 *   schema newer than this Runtime, a failed migration or an unreadable
 *   envelope quarantines that Tenant only. A lost connection or an unavailable
 *   server says nothing about the Tenant, so it is thrown, never a quarantine.
 * - `deleteTenant` drops the schema with everything in it.
 *
 * Create, migrate and delete of one schema are serialized by a
 * transaction-level advisory lock on the schema name.
 */
import type { Sql, TransactionSql } from "postgres";
import { isTenantId } from "@nylorun/core/compatibility";
import {
  TenantEnvelopeSchema,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import { STUDIO_PRINCIPAL_ID } from "../../tenant/principals.js";
import {
  TenantConflictError,
  asQuarantine,
  quarantine,
} from "../../tenant/quarantine.js";
import type { BootstrapPrincipal, Quarantine } from "../../tenant/types.js";
import type { SessionStore } from "../types.js";
import {
  MIGRATIONS,
  lockSchema,
  migrateSchemaInTx,
  readSchemaVersion,
  schemaExists,
  type Migration,
} from "./migrations/index.js";
import { TENANT_SCHEMA_PREFIX, tenantIdFromSchema, tenantSchemaName } from "./names.js";
import { createPostgresSessionStore } from "./store.js";
import { STREAMS_SCHEMA, migrateStreamsSchema } from "./migrations/shared/index.js";

export interface PostgresTenantCatalogOptions {
  /** The shared pool. The catalog and its stores never end it. */
  sql: Sql;
  /** Clock for principal `createdAt`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Passed to every opened store. */
  onError?: (error: unknown) => void;
  /** Tests only: the migrations this Runtime knows. */
  migrations?: readonly Migration[];
}

export interface TenantListing {
  id: string;
  /** Null when the envelope cannot be read; `quarantine` says why. */
  envelope: TenantEnvelope | null;
  quarantine?: Quarantine;
}

export type CreateTenantResult =
  | { status: "created"; envelope: TenantEnvelope }
  | { status: "exists"; envelope: TenantEnvelope };

export type OpenTenantResult =
  | { status: "ok"; store: SessionStore; envelope: TenantEnvelope; migrated: { from: number; to: number } }
  | { status: "quarantined"; reason: Quarantine }
  | { status: "not-found" };

export interface PostgresTenantCatalog {
  /** Every `tenant_*` schema that encodes a Tenant id, ordered by id. */
  listTenants(): Promise<TenantListing[]>;
  /** The ids of `listTenants`, without reading any envelope. */
  listTenantIds(): Promise<string[]>;
  /** Whether the Tenant's schema exists. */
  tenantExists(id: string): Promise<boolean>;
  /** Throws a `QuarantineError` (`envelope-invalid`) when unreadable. */
  readEnvelope(id: string): Promise<TenantEnvelope>;
  createTenant(input: {
    envelope: TenantEnvelope;
    principals: BootstrapPrincipal;
  }): Promise<CreateTenantResult>;
  /** Whether the stored bootstrap (and Studio) principals equal `bootstrap`. */
  bootstrapMatches(id: string, bootstrap: BootstrapPrincipal): Promise<boolean>;
  openTenant(
    id: string,
    options?: { now?: () => Date; onError?: (error: unknown) => void },
  ): Promise<OpenTenantResult>;
  /** Migrates an existing Tenant schema. Throws `schema-too-new` or the migration error. */
  migrateTenant(id: string): Promise<{ from: number; to: number }>;
  /** Drops the schema and everything in it. Returns false when it did not exist. */
  deleteTenant(id: string): Promise<boolean>;
}

/**
 * Whether Postgres rejected a statement (a SQLSTATE), rather than the connection or the
 * server failing (classes 08, 53, 57, and the driver's own connection errors). Only the
 * first says something about the Tenant's schema.
 */
function isStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !/^(08|53|57)/.test(code)
  );
}

export function createPostgresTenantCatalog(
  options: PostgresTenantCatalogOptions,
): PostgresTenantCatalog {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  // The shared record (`nylorun_streams`) exists before any Tenant is created or opened.
  let streamsReady: Promise<unknown> | undefined;
  const ensureStreams = () =>
    (streamsReady ??= migrateStreamsSchema(sql).catch((error: unknown) => {
      streamsReady = undefined;
      throw error;
    }));
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations.length;

  async function readEnvelopeWith(
    q: Sql | TransactionSql,
    id: string,
  ): Promise<TenantEnvelope> {
    const schema = tenantSchemaName(id);
    const invalid = (message: string) =>
      quarantine("envelope-invalid", message, { tenantId: id });
    let rows;
    try {
      rows = await q`
        SELECT id, name, created_at, updated_at, schema_version
        FROM ${q(`${schema}.tenant`)}`;
    } catch (error) {
      // A missing schema or `tenant` table is the Tenant's problem; anything else
      // (a lost connection) is not, and is thrown as it is.
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "3F000") throw error;
      throw invalid(
        `Tenant envelope could not be read: ${(error as Error).message}`,
      );
    }
    if (rows.length !== 1) throw invalid("Tenant envelope is missing");
    const row = rows[0]!;
    const parsed = TenantEnvelopeSchema.safeParse({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      schemaVersion: row.schema_version,
    });
    if (!parsed.success) throw invalid("Tenant envelope is not valid");
    if (parsed.data.id !== id)
      throw invalid(`Tenant envelope id ${parsed.data.id} does not match schema ${schema}`);
    return parsed.data;
  }

  async function bootstrapMatchesWith(
    q: Sql | TransactionSql,
    id: string,
    bootstrap: BootstrapPrincipal,
  ): Promise<boolean> {
    const schema = tenantSchemaName(id);
    const rows = await q`
      SELECT id, token_hash, idempotency_key FROM ${q(`${schema}.principals`)}
      WHERE role = 'application'`;
    const app = rows.find((row) => row.id === bootstrap.principalId);
    if (
      !app ||
      app.token_hash !== bootstrap.credentialHash ||
      app.idempotency_key !== bootstrap.idempotencyKey
    )
      return false;
    const studio = rows.find((row) => row.id === STUDIO_PRINCIPAL_ID);
    if (studio?.token_hash !== bootstrap.studioCredentialHash) return false;
    return (bootstrap.derivedPrincipals ?? []).every(
      (principal) =>
        rows.find((row) => row.id === principal.id)?.token_hash ===
        principal.credentialHash
    );
  }

  const catalog: PostgresTenantCatalog = {
    async listTenantIds() {
      const schemas = await sql<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace
        WHERE starts_with(nspname, ${TENANT_SCHEMA_PREFIX})
        ORDER BY nspname COLLATE "C"`;
      return schemas.flatMap(({ nspname }) => tenantIdFromSchema(nspname) ?? []);
    },

    async tenantExists(id) {
      return isTenantId(id) && schemaExists(sql, tenantSchemaName(id));
    },

    async listTenants() {
      const listings: TenantListing[] = [];
      for (const id of await catalog.listTenantIds()) {
        try {
          listings.push({ id, envelope: await readEnvelopeWith(sql, id) });
        } catch (error) {
          listings.push({
            id,
            envelope: null,
            quarantine:
              asQuarantine(error) ??
              quarantine("open-failed", "Tenant schema could not be read", {
                tenantId: id,
              }).toQuarantine(),
          });
        }
      }
      return listings;
    },

    readEnvelope(id) {
      return readEnvelopeWith(sql, id);
    },

    async createTenant({ envelope, principals }) {
      await ensureStreams();
      const input = TenantEnvelopeSchema.parse(envelope);
      const schema = tenantSchemaName(input.id);
      const outcome = await sql.begin(async (tx) => {
        await lockSchema(tx, schema);
        if (await schemaExists(tx, schema)) return { created: false as const };
        await migrateSchemaInTx(tx, schema, migrations);
        const stored: TenantEnvelope = { ...input, schemaVersion: latest };
        await tx`
          INSERT INTO ${tx(`${schema}.tenant`)} (id, name, created_at, updated_at, schema_version)
          VALUES (${stored.id}, ${stored.name}, ${stored.createdAt}, ${stored.updatedAt}, ${stored.schemaVersion})`;
        const createdAt = now().toISOString();
        await tx`
          INSERT INTO ${tx(`${schema}.principals`)} (id, role, token_hash, idempotency_key, created_at)
          VALUES (${principals.principalId}, 'application', ${principals.credentialHash},
                  ${principals.idempotencyKey}, ${createdAt})`;
        if (principals.studioCredentialHash)
          await tx`
            INSERT INTO ${tx(`${schema}.principals`)} (id, role, token_hash, idempotency_key, created_at)
            VALUES (${STUDIO_PRINCIPAL_ID}, 'application', ${principals.studioCredentialHash},
                    NULL, ${createdAt})`;
        for (const derived of principals.derivedPrincipals ?? [])
          await tx`
            INSERT INTO ${tx(`${schema}.principals`)} (id, role, token_hash, idempotency_key, created_at)
            VALUES (${derived.id}, 'application', ${derived.credentialHash}, NULL, ${createdAt})`;
        return { created: true as const, envelope: stored };
      });
      if (outcome.created) return { status: "created", envelope: outcome.envelope };
      if (!(await bootstrapMatchesWith(sql, input.id, principals)))
        throw new TenantConflictError();
      return { status: "exists", envelope: await readEnvelopeWith(sql, input.id) };
    },

    async bootstrapMatches(id, bootstrap) {
      if (!(await schemaExists(sql, tenantSchemaName(id)))) return false;
      return bootstrapMatchesWith(sql, id, bootstrap);
    },

    async openTenant(id, storeOptions = {}) {
      if (!isTenantId(id)) return { status: "not-found" };
      await ensureStreams();
      const schema = tenantSchemaName(id);
      const version = await readSchemaVersion(sql, schema);
      if (version === undefined) return { status: "not-found" };
      if (version > latest)
        return {
          status: "quarantined",
          reason: quarantine(
            "schema-too-new",
            `Tenant schema version ${version} is newer than this Runtime's ${latest}`,
            { tenantId: id },
          ).toQuarantine(),
        };
      let migrated = { from: version, to: version };
      if (version < latest) {
        try {
          migrated = await catalog.migrateTenant(id);
        } catch (error) {
          if (!asQuarantine(error) && !isStatementError(error)) throw error;
          return {
            status: "quarantined",
            reason:
              asQuarantine(error) ??
              quarantine(
                "migration-failed",
                `Tenant schema migration from version ${version} failed: ${(error as Error).message}`,
                { tenantId: id },
              ).toQuarantine(),
          };
        }
      }
      let envelope: TenantEnvelope;
      try {
        envelope = await readEnvelopeWith(sql, id);
      } catch (error) {
        const reason = asQuarantine(error);
        if (!reason) throw error;
        return { status: "quarantined", reason };
      }
      const store = createPostgresSessionStore({
        sql,
        tenantId: id,
        schema,
        schemaVersion: latest,
        now: storeOptions.now,
        onError: storeOptions.onError ?? options.onError,
      });
      return { status: "ok", store, envelope, migrated };
    },

    async migrateTenant(id) {
      const schema = tenantSchemaName(id);
      const result = await sql.begin(async (tx) => {
        await lockSchema(tx, schema);
        if (!(await schemaExists(tx, schema)))
          throw new Error(`Tenant ${id} does not exist`);
        return { result: await migrateSchemaInTx(tx, schema, migrations) };
      });
      return result.result;
    },

    async deleteTenant(id) {
      const schema = tenantSchemaName(id);
      return sql.begin(async (tx) => {
        await lockSchema(tx, schema);
        if (!(await schemaExists(tx, schema))) return false;
        await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
        // The Tenant's share of the record goes with it (Durable Streams §15).
        if ((await schemaExists(tx, STREAMS_SCHEMA))) {
          await tx`DELETE FROM ${tx(`${STREAMS_SCHEMA}.session_events`)} WHERE tenant_id = ${id}`;
          await tx`DELETE FROM ${tx(`${STREAMS_SCHEMA}.session_log_heads`)} WHERE tenant_id = ${id}`;
        }
        return true;
      });
    },
  };
  return catalog;
}
