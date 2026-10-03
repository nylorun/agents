/**
 * The migrations of a Tenant database (session-store.md §3) and the runner that applies them.
 *
 * drizzle-kit generates the migrations from `schema.ts` into `drizzle/` (SQL files and
 * `meta/_journal.json`); custom SQL migrations carry what it does not model (the schemas,
 * `nylorun.doc()`, the relay's publication). The build copies `drizzle/` next to this module
 * in `dist/`, and the Runtime reads it from there.
 *
 * The runner applies them at Host startup, before any service opens the store
 * (`tenant.ts`), in one transaction:
 *
 * 1. It lifts `statement_timeout` for the transaction and takes the database's migration
 *    lock (a transaction-level advisory lock), so two processes never migrate at once.
 * 2. It refuses an old layout (`database-layout-old`): `tenant_<id>` schemas, a record keyed
 *    by Tenant, or the hand-written migrations' `schema_version` tables of the pre-release
 *    builds of one Tenant per database. It never changes such a database.
 * 3. It reads the journal, `nylorun.__drizzle_migrations` (Drizzle's format: `id`, `hash`,
 *    `created_at`, so `drizzle-kit migrate` and Drizzle Studio read it too). A journal holding
 *    a migration this Runtime does not ship was written by a newer Runtime: `schema-too-new`,
 *    and nothing is changed. Drizzle's own migrator does not refuse; this is why the Runtime
 *    applies the files itself.
 * 4. It applies every missing migration in order and records each in the journal.
 *
 * The database's schema version is the number of migrations its journal records; this
 * Runtime expects `shippedMigrations().length`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Sql } from "postgres";
import { openError } from "../../tenant/cause.js";
import { database, driverError, type Queryable, type Transaction } from "./db.js";
import { STREAMS_SCHEMA, TENANT_SCHEMA } from "./schema.js";

/** Where the migrations are, next to this module (`src/` in development, `dist/` built). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle", import.meta.url));

/** The journal of applied migrations: `nylorun.__drizzle_migrations`. */
export const MIGRATIONS_SCHEMA = TENANT_SCHEMA;
export const MIGRATIONS_TABLE = "__drizzle_migrations";
const JOURNAL = sql.raw(`"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`);

/**
 * What schemas were called when one database held several Tenants (`"tenant_<id>"`). A
 * database that still has one was written by an older Runtime and is refused.
 */
export const OLD_TENANT_SCHEMA_PREFIX = "tenant_";

export interface Migration {
  /** The journal tag, `0001_baseline`. */
  tag: string;
  /** SHA-256 of the SQL file, as Drizzle records it. */
  hash: string;
  /** The journal's `when` (ms), recorded as `created_at`. */
  when: number;
  /** The file's statements, split at `--> statement-breakpoint`. */
  statements: readonly string[];
}

let shipped: readonly Migration[] | undefined;

/** The migrations this Runtime ships, in order. */
export function shippedMigrations(): readonly Migration[] {
  if (!shipped) {
    const journal = JSON.parse(
      readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8"),
    ) as { entries: { tag: string }[] };
    shipped = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map((file, index) => ({
      tag: journal.entries[index]!.tag,
      hash: file.hash,
      when: file.folderMillis,
      statements: file.sql,
    }));
  }
  return shipped;
}

/** The schema version this Runtime writes and expects: the number of shipped migrations. */
export function expectedSchemaVersion(): number {
  return shippedMigrations().length;
}

/**
 * Lifts `statement_timeout` for the transaction and takes the database's migration lock
 * until it ends. Waiting for the lock, and the migrations done under it, may outlast the
 * pool's statement timeout; a migration that timed out would fail the Host's readiness.
 */
export async function lockMigrations(tx: Transaction): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = 0`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('nylorun.migrations', 0))`);
}

/**
 * Throws `database-layout-old` when the database was written by an older Runtime: one that
 * kept several Tenants in one database (`tenant_<id>` schemas, a record keyed by Tenant), or a
 * pre-release build of one Tenant per database whose hand-written migrations recorded
 * themselves in `schema_version` tables.
 */
export async function assertCurrentLayout(q: Queryable): Promise<void> {
  const [row] = await q.execute<{ tenant_schemas: boolean; keyed_record: boolean; versioned: boolean }>(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_namespace WHERE starts_with(nspname, ${OLD_TENANT_SCHEMA_PREFIX})
      ) AS tenant_schemas,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${STREAMS_SCHEMA} AND table_name = 'session_events'
          AND column_name = 'tenant_id'
      ) AS keyed_record,
      to_regclass(${`${TENANT_SCHEMA}.schema_version`}) IS NOT NULL
        OR to_regclass(${`${STREAMS_SCHEMA}.schema_version`}) IS NOT NULL AS versioned`);
  if (row?.tenant_schemas || row?.keyed_record)
    throw openError(
      "database-layout-old",
      "The database was written by an older Runtime that kept several Tenants in one database " +
        "(tenant_<id> schemas). This release starts fresh with one Tenant per database and " +
        "never changes the old one: point the Runtime at a new database (locally, a new Tenant: " +
        "`nylorun start --tenant <new name>`).",
    );
  if (row?.versioned)
    throw openError(
      "database-layout-old",
      "The database was created by a pre-release build of one Tenant per database, whose " +
        "migrations this release replaces. It is never changed: point the Runtime at a new " +
        "database (locally, `nylorun reset` and then `nylorun start`).",
    );
}

/**
 * The database's schema version: the number of migrations its journal records, or undefined
 * when it has no journal (a database never migrated).
 */
export async function readSchemaVersion(q: Queryable): Promise<number | undefined> {
  const [exists] = await q.execute<{ journal: boolean }>(sql`
    SELECT to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) IS NOT NULL AS journal`);
  if (!exists?.journal) return undefined;
  const [row] = await q.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${JOURNAL}`);
  return row?.n ?? 0;
}

/**
 * Applies every migration of `migrations` the journal does not record, in `tx`. Take
 * `lockMigrations` first (`migrateDatabase` does). Throws `schema-too-new` when the journal
 * records a migration `migrations` does not have, and `migration-failed` when Postgres
 * rejects a migration.
 */
export async function applyMigrations(
  tx: Transaction,
  migrations: readonly Migration[] = shippedMigrations(),
): Promise<{ from: number; to: number }> {
  await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(`"${MIGRATIONS_SCHEMA}"`)}`);
  // Drizzle's journal table, as its migrator creates it.
  await tx.execute(sql`
    CREATE TABLE IF NOT EXISTS ${JOURNAL} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
  const applied = await tx.execute<{ hash: string }>(sql`SELECT hash FROM ${JOURNAL} ORDER BY id`);
  const known = new Set(migrations.map((migration) => migration.hash));
  const unknown = applied.filter((row) => !known.has(row.hash)).length;
  if (unknown > 0)
    throw openError(
      "schema-too-new",
      `The database has ${unknown} migration${unknown === 1 ? "" : "s"} this Runtime does not ` +
        `know (it is at schema version ${applied.length}; this Runtime's is ${migrations.length}): ` +
        "it was migrated by a newer Runtime",
    );
  applied.forEach((row, index) => {
    if (row.hash !== migrations[index]!.hash)
      throw openError(
        "migration-failed",
        `The database's migration ${index + 1} is not this Runtime's ${migrations[index]!.tag}`,
      );
  });
  for (const migration of migrations.slice(applied.length)) {
    try {
      for (const statement of migration.statements)
        if (statement.trim()) await tx.execute(sql.raw(statement));
    } catch (thrown) {
      const error = driverError(thrown);
      if (!isStatementError(error)) throw error;
      throw openError(
        "migration-failed",
        `Migration ${migration.tag} failed: ${(error as Error).message}`,
      );
    }
    await tx.execute(sql`
      INSERT INTO ${JOURNAL} (hash, created_at) VALUES (${migration.hash}, ${migration.when})`);
  }
  return { from: applied.length, to: migrations.length };
}

/**
 * Refuses an old layout and applies the missing migrations, in one transaction under the
 * migration lock. For tests and tools; the Host migrates through `openTenantDatabase`.
 */
export async function migrateDatabase(
  pool: Sql,
  migrations: readonly Migration[] = shippedMigrations(),
): Promise<{ from: number; to: number }> {
  const db = database(pool);
  try {
    return await db.transaction(async (tx) => {
      await lockMigrations(tx);
      await assertCurrentLayout(tx);
      return applyMigrations(tx, migrations);
    });
  } catch (error) {
    throw driverError(error);
  }
}

/**
 * Whether Postgres rejected a statement (a SQLSTATE), rather than the connection or the
 * server failing (classes 08, 53, 57, and the driver's own connection errors). Only the
 * first says something about the Tenant's database.
 */
export function isStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !/^(08|53|57)/.test(code)
  );
}
