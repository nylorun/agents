/**
 * The Tenant a database holds (tenancy.md §1, §4; session-store.md §2). One database is one
 * Tenant: its state in the schema `nylorun`, its record in `nylorun_streams`, and its
 * envelope in the one row of `nylorun.tenant`. There is no catalog.
 *
 * `openTenantDatabase` runs in one transaction, under the advisory locks of both schemas, so
 * several processes starting at once migrate and create once:
 *
 * 1. Refuse an old layout: a database with `tenant_<id>` schemas, or a record keyed by
 *    Tenant, was written by a Runtime from before one Tenant per installation
 *    (`database-layout-old`). It is never touched: this release starts fresh.
 * 2. Migrate `nylorun_streams`, then `nylorun`. A schema newer than this Runtime is
 *    `schema-too-new`; a migration Postgres rejects is `migration-failed`.
 * 3. When `nylorun.tenant` is empty, create the Tenant: its row (id, name, created time) and
 *    its first principals. A database whose row is gone but that holds a Tenant's data
 *    (principals, sessions, agents, vaults, keys) is `envelope-invalid`, never given a new
 *    Tenant. Principals given later that the Tenant does not have yet are added (a derived
 *    principal configured after the first start); existing ones are kept.
 * 4. Read the envelope back (`envelope-invalid` when it does not parse), and open the store.
 *
 * A lost connection or an unavailable server says nothing about the Tenant: it is thrown as
 * it is, never as a cause.
 */
import type { Sql, TransactionSql } from "postgres";
import { isTenantId, newTenantId } from "@nylorun/core/compatibility";
import {
  TenantEnvelopeSchema,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import { openError, TenantOpenError } from "../../tenant/cause.js";
import type { SessionStore } from "../types.js";
import {
  MIGRATIONS,
  lockSchema,
  migrateSchemaInTx,
  readSchemaVersion,
  type Migration,
} from "./migrations/index.js";
import {
  STREAMS_SCHEMA,
  migrateStreamsSchemaInTx,
} from "./migrations/shared/index.js";
import { OLD_TENANT_SCHEMA_PREFIX, TENANT_SCHEMA } from "./names.js";
import { createPostgresSessionStore } from "./store.js";

/** An application principal the Tenant is created with (or given later). */
export interface InitialPrincipal {
  id: string;
  /** SHA-256 hex of the principal's key. */
  credentialHash: string;
}

/** Who the Tenant is when the database holds none yet. */
export interface TenantCreation {
  /** Default: a new id (`newTenantId()`). Ignored when the Tenant exists. */
  tenantId?: string;
  /** Ignored when the Tenant exists. */
  name: string;
  /**
   * The principals the Tenant must have, given its id (derived keys depend on it). Created
   * with the Tenant; on later opens, the missing ones are added.
   */
  principals?(tenantId: string): readonly InitialPrincipal[];
}

export interface OpenTenantDatabaseOptions {
  /** The pool on the Tenant's database. The store never ends it. */
  sql: Sql;
  create: TenantCreation;
  /** Clock for the envelope and the principals' `createdAt`, and the store's. */
  now?: () => Date;
  /** Passed to the store (post-commit failures). */
  onError?: (error: unknown) => void;
  /** Tests only: the Tenant schema migrations this Runtime knows. */
  migrations?: readonly Migration[];
}

export interface OpenedTenantDatabase {
  store: SessionStore;
  envelope: TenantEnvelope;
  /** This call created the Tenant. */
  created: boolean;
  /** The Tenant schema's versions before and after. */
  migrated: { from: number; to: number };
}

/**
 * Migrates the database, creates its Tenant when it has none, and opens its Session Store.
 * Throws a `TenantOpenError` with the cause when the Tenant cannot be opened (see above).
 */
export async function openTenantDatabase(
  options: OpenTenantDatabaseOptions,
): Promise<OpenedTenantDatabase> {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations.length;
  let outcome: { created: boolean; migrated: { from: number; to: number } };
  try {
    outcome = await sql.begin(async (tx) => {
      // Always streams first, then the Tenant schema: one order for every process.
      await lockSchema(tx, STREAMS_SCHEMA);
      await lockSchema(tx, TENANT_SCHEMA);
      await assertCurrentLayout(tx);
      await migrateStreamsSchemaInTx(tx);
      let migrated: { from: number; to: number };
      try {
        migrated = await migrateSchemaInTx(tx, TENANT_SCHEMA, migrations);
      } catch (error) {
        if (error instanceof TenantOpenError || !isStatementError(error)) throw error;
        throw openError(
          "migration-failed",
          `Migrating the ${TENANT_SCHEMA} schema failed: ${(error as Error).message}`,
        );
      }
      const created = await ensureTenant(tx, options.create, latest, now);
      return { created, migrated };
    });
  } catch (error) {
    if (!(error instanceof TenantOpenError) && !isStatementError(error)) throw error;
    // A statement of the bootstrap itself (the layout check, the Tenant row) was rejected.
    const failure =
      error instanceof TenantOpenError
        ? error
        : openError("open-failed", `Opening the Tenant database failed: ${(error as Error).message}`);
    // Name the Tenant when its row reads (a database newer than this Runtime, say).
    if (failure.code !== "database-layout-old")
      failure.envelope ??= await readTenantEnvelope(sql).catch(() => undefined);
    throw failure;
  }
  const envelope = await readTenantEnvelope(sql);
  if (!envelope) throw openError("envelope-invalid", "The Tenant row is missing");
  const store = createPostgresSessionStore({
    sql,
    tenantId: envelope.id,
    schemaVersion: latest,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return { store, envelope, ...outcome };
}

/**
 * The Tenant's envelope, or undefined when the database holds no Tenant yet (no `nylorun`
 * schema, or an empty `tenant` table). Throws `envelope-invalid` when the row does not parse.
 */
export async function readTenantEnvelope(
  q: Sql | TransactionSql,
): Promise<TenantEnvelope | undefined> {
  const [exists] = await q<{ exists: boolean }[]>`
    SELECT to_regclass(${`${TENANT_SCHEMA}.tenant`}) IS NOT NULL AS exists`;
  if (!exists?.exists) return undefined;
  const rows = await q`
    SELECT id, name, created_at, updated_at, schema_version
    FROM ${q(`${TENANT_SCHEMA}.tenant`)}`;
  if (rows.length === 0) return undefined;
  const row = rows[0]!;
  const parsed = TenantEnvelopeSchema.safeParse({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
  });
  if (!parsed.success || !isTenantId(parsed.data.id))
    throw openError("envelope-invalid", "The Tenant row is not valid");
  return parsed.data;
}

/**
 * Throws `database-layout-old` when the database was written by a Runtime that kept several
 * Tenants in one database: `tenant_<id>` schemas, or a record keyed by Tenant.
 */
export async function assertCurrentLayout(q: Sql | TransactionSql): Promise<void> {
  const [row] = await q<{ tenant_schemas: boolean; keyed_record: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_namespace WHERE starts_with(nspname, ${OLD_TENANT_SCHEMA_PREFIX})
      ) AS tenant_schemas,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${STREAMS_SCHEMA} AND table_name = 'session_events'
          AND column_name = 'tenant_id'
      ) AS keyed_record`;
  if (row?.tenant_schemas || row?.keyed_record)
    throw openError(
      "database-layout-old",
      "The database was written by an older Runtime that kept several Tenants in one database " +
        "(tenant_<id> schemas). This release starts fresh with one Tenant per database and " +
        "never changes the old one: point the Runtime at a new database (with the local stack, " +
        "start a new stack).",
    );
}

/** The Tenant schema's version: undefined before the database is migrated. */
export function readTenantSchemaVersion(q: Sql | TransactionSql): Promise<number | undefined> {
  return readSchemaVersion(q, TENANT_SCHEMA);
}

/** Creates the Tenant when there is none, and adds the principals it is missing. */
async function ensureTenant(
  tx: TransactionSql,
  create: TenantCreation,
  schemaVersion: number,
  now: () => Date,
): Promise<boolean> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM ${tx(`${TENANT_SCHEMA}.tenant`)}`;
  const createdAt = now().toISOString();
  let tenantId = existing?.id;
  if (tenantId === undefined) {
    const [data] = await tx<{ held: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM ${tx(`${TENANT_SCHEMA}.principals`)})
        OR EXISTS (SELECT 1 FROM ${tx(`${TENANT_SCHEMA}.sessions`)})
        OR EXISTS (SELECT 1 FROM ${tx(`${TENANT_SCHEMA}.definitions`)})
        OR EXISTS (SELECT 1 FROM ${tx(`${TENANT_SCHEMA}.vaults`)})
        OR EXISTS (SELECT 1 FROM ${tx(`${TENANT_SCHEMA}.signing_keys`)}) AS held`;
    if (data?.held)
      throw openError(
        "envelope-invalid",
        "The Tenant row is missing from a database that holds a Tenant's data: restore it from a backup",
      );
    tenantId = create.tenantId ?? newTenantId();
    if (!isTenantId(tenantId)) throw new Error(`Invalid Tenant id: ${tenantId}`);
    if (!create.name) throw new Error("A Tenant needs a name");
    await tx`
      INSERT INTO ${tx(`${TENANT_SCHEMA}.tenant`)} (id, name, created_at, updated_at, schema_version)
      VALUES (${tenantId}, ${create.name}, ${createdAt}, ${createdAt}, ${schemaVersion})`;
  }
  for (const principal of create.principals?.(tenantId) ?? [])
    // A principal with this id or this key already exists: it is kept as it is.
    await tx`
      INSERT INTO ${tx(`${TENANT_SCHEMA}.principals`)} (id, role, token_hash, idempotency_key, created_at)
      VALUES (${principal.id}, 'application', ${principal.credentialHash}, NULL, ${createdAt})
      ON CONFLICT DO NOTHING`;
  return existing === undefined;
}

/**
 * Whether Postgres rejected a statement (a SQLSTATE), rather than the connection or the
 * server failing (classes 08, 53, 57, and the driver's own connection errors). Only the
 * first says something about the Tenant's database.
 */
function isStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !/^(08|53|57)/.test(code)
  );
}
