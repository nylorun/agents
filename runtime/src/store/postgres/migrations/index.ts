/**
 * Forward-only, numbered migrations of one Tenant schema (architecture §14.6).
 *
 * Each schema records what it has applied in `<schema>.schema_version`, one
 * row per migration; its version is the highest row. Migrating runs every
 * missing step in order, in the caller's transaction, under a transaction-level
 * advisory lock on the schema so two processes never migrate the same schema
 * at once. A schema newer than the Runtime is never touched: migrating it
 * throws a `schema-too-new` quarantine and the Tenant is quarantined.
 *
 * Adding a migration: append `NNN_name.ts` with the next version to
 * `MIGRATIONS`. Never edit or reorder an applied migration.
 */
import type { Sql, TransactionSql } from "postgres";
import { quarantine } from "../../../tenant/quarantine.js";
import { quoteIdentifier, tenantIdFromSchema } from "../names.js";
import { initial } from "./001_initial.js";
import { sessionOwner } from "./002_session_owner.js";
import { subjectTokens } from "./003_subject_tokens.js";
import { publishableKeys } from "./004_publishable_keys.js";
import { actionEndpoints } from "./005_action_endpoints.js";
import { dropExecutors } from "./006_drop_executors.js";
import { eventTime } from "./007_event_time.js";
import { durableStreams } from "./008_durable_streams.js";

export interface Migration {
  /** 1, 2, 3, … without gaps. */
  version: number;
  name: string;
  /** DDL for the quoted schema name `s` (for example `"tenant_tn_…"`). */
  up(s: string): string;
}

export const MIGRATIONS: readonly Migration[] = [
  initial,
  sessionOwner,
  subjectTokens,
  publishableKeys,
  actionEndpoints,
  dropExecutors,
  eventTime,
  durableStreams,
];

/** The schema version this Runtime writes and expects. */
export const POSTGRES_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/** Checks that versions run 1, 2, 3, … Throws otherwise. */
export function assertMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new Error(
        `Migration ${migration.name} has version ${migration.version}, expected ${index + 1}`,
      );
  });
}

/** Takes the schema's migration lock until the transaction ends. */
export async function lockSchema(
  tx: TransactionSql,
  schema: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`nylorun.schema:${schema}`}, 0))`;
}

export async function schemaExists(
  sql: Sql | TransactionSql,
  schema: string,
): Promise<boolean> {
  const rows =
    await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`;
  return rows.length > 0;
}

/**
 * The schema's version: 0 when it exists without a `schema_version` table,
 * undefined when the schema does not exist.
 */
export async function readSchemaVersion(
  sql: Sql | TransactionSql,
  schema: string,
): Promise<number | undefined> {
  const [row] = await sql<{ has_schema: boolean; has_table: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schema}) AS has_schema,
      to_regclass(${`${quoteIdentifier(schema)}.schema_version`}) IS NOT NULL AS has_table`;
  if (!row!.has_schema) return undefined;
  if (!row!.has_table) return 0;
  const [version] = await sql<{ version: number | null }[]>`
    SELECT max(version)::int AS version FROM ${sql(`${schema}.schema_version`)}`;
  return version?.version ?? 0;
}

/**
 * Creates the schema when missing and applies every missing migration, inside
 * `tx`. Call `lockSchema` first when other processes may migrate concurrently
 * (`migrateSchema` does). Throws a `schema-too-new` `QuarantineError` when the
 * schema is ahead of `migrations`.
 */
export async function migrateSchemaInTx(
  tx: TransactionSql,
  schema: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number }> {
  assertMigrations(migrations);
  const s = quoteIdentifier(schema);
  const latest = migrations.length;
  await tx.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${s};
    CREATE TABLE IF NOT EXISTS ${s}.schema_version (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );`);
  const from = (await readSchemaVersion(tx, schema)) ?? 0;
  if (from > latest)
    throw quarantine(
      "schema-too-new",
      `Tenant schema version ${from} is newer than this Runtime's ${latest}`,
      { tenantId: tenantIdFromSchema(schema) ?? schema },
    );
  for (const migration of migrations.slice(from)) {
    await tx.unsafe(migration.up(s));
    await tx`INSERT INTO ${tx(`${schema}.schema_version`)} (version, name)
             VALUES (${migration.version}, ${migration.name})`;
  }
  if (from < latest)
    await tx`UPDATE ${tx(`${schema}.tenant`)} SET schema_version = ${latest}`;
  return { from, to: latest };
}

/** `migrateSchemaInTx` in its own transaction, under the schema's migration lock. */
export async function migrateSchema(
  sql: Sql,
  schema: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number }> {
  const result = await sql.begin(async (tx) => {
    await lockSchema(tx, schema);
    return { result: await migrateSchemaInTx(tx, schema, migrations) };
  });
  return result.result;
}
