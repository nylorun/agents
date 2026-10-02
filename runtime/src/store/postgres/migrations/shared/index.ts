/**
 * Forward-only migrations of the `nylorun_streams` schema (Durable Streams §6,
 * session-store.md §2): the record of the Tenant's session events, the log heads, the relay's
 * state and the publication the stream relay reads. The database holds one Tenant, so no
 * table carries a Tenant id. It is migrated with the Tenant schema, before the Tenant opens
 * (`store/postgres/tenant.ts`), under its own advisory lock.
 *
 * Adding a migration: append to `STREAMS_MIGRATIONS` with the next version. Never edit or
 * reorder an applied one.
 */
import type { Sql, TransactionSql } from "postgres";
import { openError } from "../../../../tenant/cause.js";
import { assertMigrations, lockSchema, type Migration } from "../index.js";

export const STREAMS_SCHEMA = "nylorun_streams";
/** The publication the stream relay subscribes to. */
export const STREAMS_PUBLICATION = "nylorun_stream_relay";

export const STREAMS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "record",
    up: (s) => `
      CREATE TABLE ${s}.session_log_heads (
        session_id text COLLATE "C" PRIMARY KEY,
        -- The basin generation the session's events go to.
        generation integer NOT NULL,
        -- The next seq.
        head bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE ${s}.session_events (
        session_id text COLLATE "C" NOT NULL,
        seq bigint NOT NULL,
        generation integer NOT NULL,
        type text NOT NULL,
        -- The nylorun.event/2 envelope, as written.
        body json NOT NULL,
        committed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, seq)
      );
      -- One row per replication slot: whether the record still has to be reconciled with S2
      -- after the slot was created (a crash during reconciliation leaves it pending).
      CREATE TABLE ${s}.relay_slots (
        slot_name text PRIMARY KEY,
        reconcile_pending boolean NOT NULL
      );
      CREATE PUBLICATION ${STREAMS_PUBLICATION}
        FOR TABLE ${s}.session_events WITH (publish = 'insert');
    `,
  },
];

/** The record schema version this Runtime writes and expects. */
export const STREAMS_SCHEMA_VERSION = STREAMS_MIGRATIONS.at(-1)!.version;

/**
 * Creates `nylorun_streams` when missing and applies every missing migration, in one
 * transaction under the schema's migration lock. Throws `schema-too-new` when the schema is
 * newer than this Runtime.
 */
export async function migrateStreamsSchema(
  sql: Sql,
  migrations: readonly Migration[] = STREAMS_MIGRATIONS,
): Promise<{ from: number; to: number }> {
  const result = await sql.begin(async (tx) => {
    await lockSchema(tx, STREAMS_SCHEMA);
    return { result: await migrateStreamsSchemaInTx(tx, migrations) };
  });
  return result.result;
}

/** `migrateStreamsSchema` in the caller's transaction; take `lockSchema` first. */
export async function migrateStreamsSchemaInTx(
  tx: TransactionSql,
  migrations: readonly Migration[] = STREAMS_MIGRATIONS,
): Promise<{ from: number; to: number }> {
  assertMigrations(migrations);
  const s = STREAMS_SCHEMA;
  await tx.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${s};
    CREATE TABLE IF NOT EXISTS ${s}.schema_version (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );`);
  const [row] = await tx<{ version: number | null }[]>`
    SELECT max(version)::int AS version FROM ${tx(`${s}.schema_version`)}`;
  const from = row?.version ?? 0;
  const latest = migrations.length;
  if (from > latest)
    throw openError(
      "schema-too-new",
      `The ${s} schema is at version ${from}, newer than this Runtime's ${latest}`,
    );
  for (const migration of migrations.slice(from)) {
    await tx.unsafe(migration.up(s));
    await tx`INSERT INTO ${tx(`${s}.schema_version`)} (version, name)
             VALUES (${migration.version}, ${migration.name})`;
  }
  return { from, to: latest };
}

/**
 * Throws, naming the setting, when Postgres cannot run the stream relay: logical decoding
 * needs `wal_level = logical` (a restart) and a role allowed to replicate.
 */
export async function assertLogicalReplication(sql: Sql): Promise<void> {
  const [row] = await sql<{ wal_level: string; replicates: boolean }[]>`
    SELECT current_setting('wal_level') AS wal_level,
           (SELECT rolreplication OR rolsuper FROM pg_roles WHERE rolname = current_user) AS replicates`;
  if (row?.wal_level !== "logical")
    throw new Error(
      `Postgres has wal_level = ${row?.wal_level ?? "unknown"}; the stream relay needs logical replication. ` +
        "Set wal_level = logical and restart Postgres (`nylorun start` does this for the local stack; " +
        "on a managed Postgres, turn on its logical replication option). See DEPLOYMENT.md.",
    );
  if (!row.replicates)
    throw new Error(
      "The Runtime's Postgres role cannot replicate: grant it REPLICATION (ALTER ROLE … REPLICATION). See DEPLOYMENT.md.",
    );
}
