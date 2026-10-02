/**
 * The Tenant a database holds (`store/postgres/tenant.ts`): migrated and created on first
 * open, found again after, and refused when the database is not one this Runtime may open.
 */
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  readSchemaVersion,
  type Migration,
} from "../../src/store/postgres/migrations/index.js";
import {
  STREAMS_SCHEMA_VERSION,
  migrateStreamsSchema,
} from "../../src/store/postgres/migrations/shared/index.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/names.js";
import {
  openTenantDatabase,
  readTenantEnvelope,
  type OpenTenantDatabaseOptions,
} from "../../src/store/postgres/tenant.js";
import type { SessionStore } from "../../src/store/types.js";
import { emptyTestDatabase, tenantTestDatabase } from "../support/database.js";

const hex = (c: string) => c.repeat(64);
const stores: SessionStore[] = [];

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
    schemaVersion: POSTGRES_SCHEMA_VERSION,
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
        { id: "babai", credentialHash: hex("d") },
      ],
    },
  });
  expect(again.created).toBe(false);
  expect(again.envelope).toEqual(first.envelope);
  expect(await principals(sql)).toEqual([
    { id: "babai", token_hash: hex("d") },
    { id: "project", token_hash: hex("b") },
    { id: "studio", token_hash: hex("a") },
  ]);
});

it("creates the Tenant once when several processes open a new database at once", async () => {
  const { sql } = await emptyTestDatabase();
  const opened = await Promise.all(Array.from({ length: 4 }, () => open(sql)));
  expect(opened.filter((o) => o.created)).toHaveLength(1);
  expect(new Set(opened.map((o) => o.envelope.id)).size).toBe(1);
  expect(await readSchemaVersion(sql, TENANT_SCHEMA)).toBe(POSTGRES_SCHEMA_VERSION);
  expect(await readSchemaVersion(sql, "nylorun_streams")).toBe(STREAMS_SCHEMA_VERSION);
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
  expect(await readSchemaVersion(sql, TENANT_SCHEMA)).toBeUndefined();
  expect(await readSchemaVersion(sql, "nylorun_streams")).toBeUndefined();
});

it("refuses a database whose record is keyed by Tenant (the old layout)", async () => {
  const { sql } = await emptyTestDatabase();
  await sql.unsafe(`
    CREATE SCHEMA nylorun_streams;
    CREATE TABLE nylorun_streams.session_events (
      tenant_id text, session_id text, seq bigint, PRIMARY KEY (tenant_id, session_id, seq))`);
  await expect(open(sql)).rejects.toMatchObject({ code: "database-layout-old" });
  expect(await readSchemaVersion(sql, TENANT_SCHEMA)).toBeUndefined();
});

it("refuses a database migrated by a newer Runtime, without touching it", async () => {
  const { sql } = await tenantTestDatabase();
  const created = await open(sql);
  await sql`INSERT INTO ${sql(`${TENANT_SCHEMA}.schema_version`)} (version, name)
            VALUES (${POSTGRES_SCHEMA_VERSION + 1}, 'future')`;
  await expect(open(sql)).rejects.toMatchObject({ code: "schema-too-new" });
  expect(await readSchemaVersion(sql, TENANT_SCHEMA)).toBe(POSTGRES_SCHEMA_VERSION + 1);
  expect((await readTenantEnvelope(sql))?.id).toBe(created.envelope.id);

  const streams = await tenantTestDatabase();
  await streams.sql`INSERT INTO nylorun_streams.schema_version (version, name)
                    VALUES (${STREAMS_SCHEMA_VERSION + 1}, 'future')`;
  await expect(open(streams.sql)).rejects.toMatchObject({ code: "schema-too-new" });
  // Migrating the record alone says the same.
  await expect(migrateStreamsSchema(streams.sql)).rejects.toMatchObject({ code: "schema-too-new" });
});

it("migrates an older Tenant schema forward; the older Runtime then refuses it", async () => {
  const { sql } = await tenantTestDatabase();
  const created = await open(sql);
  const next: Migration = {
    version: MIGRATIONS.length + 1,
    name: "add_notes",
    up: (s) => `CREATE TABLE ${s}.notes (id text PRIMARY KEY);`,
  };
  const migrated = await open(sql, { migrations: [...MIGRATIONS, next] });
  expect(migrated.migrated).toEqual({ from: MIGRATIONS.length, to: next.version });
  expect(migrated.envelope).toMatchObject({ id: created.envelope.id, schemaVersion: next.version });
  expect(await migrated.store.health()).toMatchObject({ ok: true, schemaVersion: next.version });
  await expect(open(sql)).rejects.toMatchObject({ code: "schema-too-new" });
});

it("fails with migration-failed when a migration is rejected, and rolls it back", async () => {
  const { sql } = await tenantTestDatabase();
  await open(sql);
  const broken: Migration = {
    version: MIGRATIONS.length + 1,
    name: "broken",
    up: (s) => `CREATE TABLE ${s}.half (id text); SELECT 1/0;`,
  };
  await expect(open(sql, { migrations: [...MIGRATIONS, broken] })).rejects.toMatchObject({
    code: "migration-failed",
  });
  expect(await readSchemaVersion(sql, TENANT_SCHEMA)).toBe(MIGRATIONS.length);
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
