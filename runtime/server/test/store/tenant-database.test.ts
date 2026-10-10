/**
 * The Tenant a database holds (`store/postgres/tenant.ts`): migrated and created on first
 * open, found again after, and refused when the database is not one this Runtime may open.
 */
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { database } from "../../src/store/postgres/db.js";
import {
  migrateDatabase,
  readSchemaVersion,
  shippedMigrations,
  type Migration,
} from "../../src/store/postgres/migrate.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/schema.js";
import {
  openTenantDatabase,
  readTenantEnvelope,
  type OpenTenantDatabaseOptions,
} from "../../src/store/postgres/tenant.js";
import type { SessionStore } from "../../src/store/types.js";
import { emptyTestDatabase, tenantTestDatabase } from "../support/database.js";

const hex = (c: string) => c.repeat(64);
const stores: SessionStore[] = [];
const MIGRATIONS = shippedMigrations();
const LATEST = MIGRATIONS.length;

/** A migration this Runtime does not ship, as a newer one would. */
function migration(tag: string, text: string): Migration {
  return {
    tag,
    hash: createHash("sha256").update(text).digest("hex"),
    when: MIGRATIONS.at(-1)!.when + 1,
    statements: text.split("--> statement-breakpoint"),
  };
}

const version = (sql: PostgresClient) => readSchemaVersion(database(sql));

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function open(sql: PostgresClient, options: Partial<OpenTenantDatabaseOptions> = {}) {
  const opened = await openTenantDatabase({
    sql,
    create: { name: "demo" },
    now: () => new Date("2030-01-02T00:00:00.000Z"),
    ...options,
  });
  stores.push(opened.store);
  return opened;
}

async function principals(sql: PostgresClient) {
  return sql<{ id: string; token_hash: string }[]>`
    SELECT id, token_hash FROM ${sql(`${TENANT_SCHEMA}.principals`)} ORDER BY id`;
}

it("creates the Tenant on first open, with its principals, and finds it again after", async () => {
  const { sql } = await tenantTestDatabase();
  const id = newTenantId();
  const first = await open(sql, {
    create: {
      tenantId: id,
      name: "demo",
      principals: (tenantId) => {
        expect(tenantId).toBe(id);
        return [
          { id: "studio", credentialHash: hex("a") },
          { id: "project", credentialHash: hex("b") },
        ];
      },
    },
  });
  expect(first.created).toBe(true);
  expect(first.envelope).toEqual({
    id,
    name: "demo",
    createdAt: "2030-01-02T00:00:00.000Z",
    updatedAt: "2030-01-02T00:00:00.000Z",
    schemaVersion: LATEST,
  });
  expect(first.store.tenantId).toBe(id);
  expect(await principals(sql)).toEqual([
    { id: "project", token_hash: hex("b") },
    { id: "studio", token_hash: hex("a") },
  ]);

  // Later opens: the same Tenant, whatever id and name are configured; a principal added to
  // the configuration is added, existing ones are kept as they are.
  const again = await open(sql, {
    create: {
      tenantId: newTenantId(),
      name: "renamed",
      principals: () => [
        { id: "studio", credentialHash: hex("c") },
        { id: "backend", credentialHash: hex("d") },
      ],
    },
  });
  expect(again.created).toBe(false);
  expect(again.envelope).toEqual(first.envelope);
  expect(await principals(sql)).toEqual([
    { id: "backend", token_hash: hex("d") },
    { id: "project", token_hash: hex("b") },
    { id: "studio", token_hash: hex("a") },
  ]);
});

it("creates the Tenant once when several processes open a new database at once", async () => {
  const { sql } = await emptyTestDatabase();
  const opened = await Promise.all(Array.from({ length: 4 }, () => open(sql)));
  expect(opened.filter((o) => o.created)).toHaveLength(1);
  expect(new Set(opened.map((o) => o.envelope.id)).size).toBe(1);
  expect(await version(sql)).toBe(LATEST);
});

it("applies the migrations to an empty database once: migrating again changes nothing", async () => {
  const { sql } = await emptyTestDatabase();
  expect(await version(sql)).toBeUndefined();
  expect(await migrateDatabase(sql)).toEqual({ from: 0, to: LATEST });
  expect(await migrateDatabase(sql)).toEqual({ from: LATEST, to: LATEST });
  const journal = await sql<{ hash: string; created_at: string }[]>`
    SELECT hash, created_at FROM nylorun.__drizzle_migrations ORDER BY id`;
  expect(journal.map((row) => [row.hash, Number(row.created_at)])).toEqual(
    MIGRATIONS.map((m) => [m.hash, m.when]),
  );
  expect(await version(sql)).toBe(LATEST);
  const [publication] = await sql`
    SELECT pubinsert, pubupdate, pubdelete FROM pg_publication WHERE pubname = 'nylorun_stream_relay'`;
  expect(publication).toEqual({ pubinsert: true, pubupdate: false, pubdelete: false });
});

it("refuses a database with Tenant schemas of the old layout, and leaves it as it is", async () => {
  const { sql } = await emptyTestDatabase();
  const old = `tenant_${newTenantId()}`;
  await sql.unsafe(`CREATE SCHEMA ${old}; CREATE TABLE ${old}.tenant (id text)`);
  await expect(open(sql)).rejects.toMatchObject({
    name: "TenantOpenError",
    code: "database-layout-old",
    message: expect.stringContaining("starts fresh"),
  });
  expect(await version(sql)).toBeUndefined();
});

it("refuses a database whose record is keyed by Tenant (the old layout)", async () => {
  const { sql } = await emptyTestDatabase();
  await sql.unsafe(`
    CREATE SCHEMA nylorun_streams;
    CREATE TABLE nylorun_streams.session_events (
      tenant_id text, session_id text, seq bigint, PRIMARY KEY (tenant_id, session_id, seq))`);
  await expect(open(sql)).rejects.toMatchObject({ code: "database-layout-old" });
  expect(await version(sql)).toBeUndefined();
});

it("refuses a database created by the pre-release hand-written migrations, and leaves it as it is", async () => {
  const { sql } = await emptyTestDatabase();
  await sql.unsafe(`
    CREATE SCHEMA nylorun;
    CREATE TABLE nylorun.schema_version (version integer PRIMARY KEY, name text NOT NULL);
    INSERT INTO nylorun.schema_version VALUES (8, 'durable_streams');`);
  await expect(open(sql)).rejects.toMatchObject({
    code: "database-layout-old",
    message: expect.stringContaining("pre-release"),
  });
  await expect(migrateDatabase(sql)).rejects.toMatchObject({ code: "database-layout-old" });
  expect(await version(sql)).toBeUndefined();
  const [row] = await sql`SELECT count(*)::int AS n FROM nylorun.schema_version`;
  expect(row!.n).toBe(1);
});

it("refuses a database migrated by a newer Runtime, without touching it", async () => {
  const { sql } = await tenantTestDatabase();
  const created = await open(sql);
  await sql`INSERT INTO nylorun.__drizzle_migrations (hash, created_at)
            VALUES (${hex("f")}, ${MIGRATIONS.at(-1)!.when + 1})`;
  await expect(open(sql)).rejects.toMatchObject({
    code: "schema-too-new",
    envelope: { id: created.envelope.id },
  });
  await expect(migrateDatabase(sql)).rejects.toMatchObject({ code: "schema-too-new" });
  expect(await version(sql)).toBe(LATEST + 1);
  expect((await readTenantEnvelope(sql))?.id).toBe(created.envelope.id);
  expect(await created.store.health()).toEqual({
    ok: false,
    schemaVersion: LATEST + 1,
    expectedSchemaVersion: LATEST,
  });
});

it("migrates an older database forward; the older Runtime then refuses it", async () => {
  const { sql } = await tenantTestDatabase();
  const created = await open(sql);
  const next = migration("9999_add_notes", "CREATE TABLE nylorun.notes (id text PRIMARY KEY);");
  const migrated = await open(sql, { migrations: [...MIGRATIONS, next] });
  expect(migrated.migrated).toEqual({ from: LATEST, to: LATEST + 1 });
  expect(migrated.envelope).toMatchObject({ id: created.envelope.id, schemaVersion: LATEST + 1 });
  expect(await migrated.store.health()).toMatchObject({ ok: true, schemaVersion: LATEST + 1 });
  await expect(open(sql)).rejects.toMatchObject({ code: "schema-too-new" });
});

it("fails with migration-failed when a migration is rejected, and rolls it back", async () => {
  const { sql } = await tenantTestDatabase();
  await open(sql);
  const broken = migration(
    "9999_broken",
    "CREATE TABLE nylorun.half (id text);\n--> statement-breakpoint\nSELECT 1/0;",
  );
  await expect(open(sql, { migrations: [...MIGRATIONS, broken] })).rejects.toMatchObject({
    code: "migration-failed",
    message: expect.stringContaining("9999_broken"),
  });
  expect(await version(sql)).toBe(LATEST);
  const [row] = await sql`SELECT to_regclass('nylorun.half') AS half`;
  expect(row!.half).toBeNull();
  expect((await open(sql)).created).toBe(false);
});

it("never gives a database that holds a Tenant's data a new Tenant", async () => {
  const { sql } = await tenantTestDatabase();
  await open(sql, { create: { name: "demo", principals: () => [{ id: "studio", credentialHash: hex("a") }] } });
  await sql`DELETE FROM ${sql(`${TENANT_SCHEMA}.tenant`)}`;
  await expect(open(sql)).rejects.toMatchObject({ code: "envelope-invalid" });
  expect(await readTenantEnvelope(sql)).toBeUndefined();
});
