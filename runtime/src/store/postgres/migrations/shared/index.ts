/**
 * Forward-only migrations of the shared `nylorun_streams` schema (Durable Streams §6): the
 * record of every Tenant's session events, the log heads, the relay's state and the
 * publication the stream relay reads. Unlike Tenant schemas, there is one for the database;
 * the Host migrates it at startup, before any Tenant opens, under an advisory lock.
 *
 * Adding a migration: append to `STREAMS_MIGRATIONS` with the next version. Never edit or
 * reorder an applied one.
 */
import type { Sql, TransactionSql } from "postgres";
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
        tenant_id text COLLATE "C" NOT NULL,
        session_id text COLLATE "C" NOT NULL,
        -- The basin generation the session's events go to.
        generation integer NOT NULL,
        -- The next seq.
        head bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, session_id)
      );
      CREATE TABLE ${s}.session_events (
        tenant_id text COLLATE "C" NOT NULL,
        session_id text COLLATE "C" NOT NULL,
        seq bigint NOT NULL,
        generation integer NOT NULL,
        type text NOT NULL,
        -- The nylorun.event/2 envelope, as written.
        body json NOT NULL,
        committed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, session_id, seq)
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

/** The shared schema version this Runtime writes and expects. */
export const STREAMS_SCHEMA_VERSION = STREAMS_MIGRATIONS.at(-1)!.version;

/**
 * Creates `nylorun_streams` when missing and applies every missing migration, in one
 * transaction under the schema's migration lock. Throws when the schema is newer than this
 * Runtime.
 */
export async function migrateStreamsSchema(
  sql: Sql,
  migrations: readonly Migration[] = STREAMS_MIGRATIONS,
): Promise<{ from: number; to: number }> {
  assertMigrations(migrations);
  const result = await sql.begin(async (tx) => {
    await lockSchema(tx, STREAMS_SCHEMA);
    return { result: await migrateInTx(tx, migrations) };
  });
  return result.result;
}

async function migrateInTx(
  tx: TransactionSql,
  migrations: readonly Migration[],
): Promise<{ from: number; to: number }> {
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
    throw new Error(
      `The ${s} schema is at version ${from}, newer than this Runtime's ${latest}: upgrade the Runtime`,
    );
  for (const migration of migrations.slice(from)) {
    await tx.unsafe(migration.up(s));
    await tx`INSERT INTO ${tx(`${s}.schema_version`)} (version, name)
             VALUES (${migration.version}, ${migration.name})`;
  }
  return { from, to: latest };
}
