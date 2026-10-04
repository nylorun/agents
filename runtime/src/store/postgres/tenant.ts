/**
 * The Tenant a database holds (tenancy.md §1, §4; session-store.md §2). One database is one
 * Tenant: its state in the schema `nylorun`, its record in `nylorun_streams`, and its
 * envelope in the one row of `nylorun.tenant`. There is no catalog.
 *
 * `openTenantDatabase` runs in one transaction, under the database's migration lock
 * (`migrate.ts`), so several processes starting at once migrate and create once:
 *
 * 1. Refuse an old layout (`database-layout-old`): `tenant_<id>` schemas or a record keyed by
 *    Tenant (a Runtime from before one Tenant per installation), or the `schema_version`
 *    tables of a pre-release build of it. It is never touched: this release starts fresh.
 * 2. Apply the missing migrations (`migrate.ts`). A database with migrations this Runtime
 *    does not know is `schema-too-new`; a migration Postgres rejects is `migration-failed`.
 * 3. When `nylorun.tenant` is empty, create the Tenant: its row (id, name, created time) and
 *    its first principals. A database whose row is gone but that holds a Tenant's data
 *    (principals, sessions, agents, vaults, keys) is `envelope-invalid`, never given a new
 *    Tenant. Principals given later that the Tenant does not have yet are added (the
 *    ephemeral Runtime's application key); existing ones are kept, as ordinary keys.
 * 4. Read the envelope back (`envelope-invalid` when it does not parse), and open the store.
 *
 * A lost connection or an unavailable server says nothing about the Tenant: it is thrown as
 * it is, never as a cause.
 */
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { isTenantId, newTenantId } from "@nylorun/core/compatibility";
import {
  TenantEnvelopeSchema,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import { openError, TenantOpenError } from "../../tenant/cause.js";
import type { SessionStore } from "../types.js";
import { database, driverError, type Queryable, type Transaction } from "./db.js";
import {
  applyMigrations,
  assertCurrentLayout,
  isStatementError,
  lockMigrations,
  shippedMigrations,
  type Migration,
} from "./migrate.js";
import {
  definitions,
  principals,
  sessions,
  signingKeys,
  TENANT_SCHEMA,
  tenant,
  vaults,
} from "./schema.js";
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
   * The principals the Tenant must have, given its id (Studio's derived key depends on it). Created
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
  /** Tests only: the migrations this Runtime knows. Default: the shipped ones. */
  migrations?: readonly Migration[];
}

export interface OpenedTenantDatabase {
  store: SessionStore;
  envelope: TenantEnvelope;
  /** This call created the Tenant. */
  created: boolean;
  /** The schema versions (applied migrations) before and after. */
  migrated: { from: number; to: number };
}

/**
 * Migrates the database, creates its Tenant when it has none, and opens its Session Store.
 * Throws a `TenantOpenError` with the cause when the Tenant cannot be opened (see above).
 */
export async function openTenantDatabase(
  options: OpenTenantDatabaseOptions,
): Promise<OpenedTenantDatabase> {
  const { sql: pool } = options;
  const db = database(pool);
  const now = options.now ?? (() => new Date());
  const migrations = options.migrations ?? shippedMigrations();
  let outcome: { created: boolean; migrated: { from: number; to: number } };
  try {
    outcome = await db.transaction(async (tx) => {
      await lockMigrations(tx);
      await assertCurrentLayout(tx);
      const migrated = await applyMigrations(tx, migrations);
      const created = await ensureTenant(tx, options.create, migrated, now);
      return { created, migrated };
    });
  } catch (thrown) {
    const error = driverError(thrown);
    if (!(error instanceof TenantOpenError) && !isStatementError(error)) throw error;
    // A statement of the bootstrap itself (the layout check, the Tenant row) was rejected.
    const failure =
      error instanceof TenantOpenError
        ? error
        : openError("open-failed", `Opening the Tenant database failed: ${(error as Error).message}`);
    // Name the Tenant when its row reads (a database newer than this Runtime, say).
    if (failure.code !== "database-layout-old")
      failure.envelope ??= await readTenantEnvelope(db).catch(() => undefined);
    throw failure;
  }
  const envelope = await readTenantEnvelope(db);
  if (!envelope) throw openError("envelope-invalid", "The Tenant row is missing");
  const store = createPostgresSessionStore({
    sql: pool,
    tenantId: envelope.id,
    schemaVersion: migrations.length,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return { store, envelope, ...outcome };
}

/**
 * The Tenant's envelope, or undefined when the database holds no Tenant yet (no `nylorun`
 * schema, or an empty `tenant` table). Throws `envelope-invalid` when the row does not parse.
 * Takes the pool or a Drizzle database or transaction on it.
 */
export async function readTenantEnvelope(
  q: Sql | Queryable,
): Promise<TenantEnvelope | undefined> {
  const db = typeof q === "function" ? database(q) : q;
  try {
    const [table] = await db.execute<{ exists: boolean }>(sql`
      SELECT to_regclass(${`${TENANT_SCHEMA}.tenant`}) IS NOT NULL AS exists`);
    if (!table?.exists) return undefined;
    const [row] = await db
      .select({
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
        schemaVersion: tenant.schemaVersion,
      })
      .from(tenant);
    if (!row) return undefined;
    const parsed = TenantEnvelopeSchema.safeParse(row);
    if (!parsed.success || !isTenantId(parsed.data.id))
      throw openError("envelope-invalid", "The Tenant row is not valid");
    return parsed.data;
  } catch (error) {
    throw driverError(error);
  }
}

/**
 * Creates the Tenant when there is none, and adds the principals it is missing. Records the
 * schema version on the Tenant row when this transaction migrated.
 */
async function ensureTenant(
  tx: Transaction,
  create: TenantCreation,
  migrated: { from: number; to: number },
  now: () => Date,
): Promise<boolean> {
  const [existing] = await tx.select({ id: tenant.id }).from(tenant);
  const createdAt = now().toISOString();
  let tenantId = existing?.id;
  if (tenantId === undefined) {
    const [data] = await tx.execute<{ held: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM ${principals})
        OR EXISTS (SELECT 1 FROM ${sessions})
        OR EXISTS (SELECT 1 FROM ${definitions})
        OR EXISTS (SELECT 1 FROM ${vaults})
        OR EXISTS (SELECT 1 FROM ${signingKeys}) AS held`);
    if (data?.held)
      throw openError(
        "envelope-invalid",
        "The Tenant row is missing from a database that holds a Tenant's data: restore it from a backup",
      );
    tenantId = create.tenantId ?? newTenantId();
    if (!isTenantId(tenantId)) throw new Error(`Invalid Tenant id: ${tenantId}`);
    if (!create.name) throw new Error("A Tenant needs a name");
    await tx.insert(tenant).values({
      id: tenantId,
      name: create.name,
      createdAt,
      updatedAt: createdAt,
      schemaVersion: migrated.to,
    });
  } else if (migrated.from !== migrated.to) {
    await tx.update(tenant).set({ schemaVersion: migrated.to });
  }
  for (const principal of create.principals?.(tenantId) ?? [])
    // A principal with this id or this key already exists: it is kept as it is.
    await tx
      .insert(principals)
      .values({
        id: principal.id,
        role: "application",
        tokenHash: principal.credentialHash,
        idempotencyKey: null,
        createdAt,
      })
      .onConflictDoNothing();
  return existing === undefined;
}
