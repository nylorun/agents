/**
 * Test databases on the test stack's Postgres (`test/stack/compose.yaml`; session-store.md §5).
 *
 * Global setup (`test/global-setup.ts`) migrates a template database once per run: both
 * schemas, no Tenant. Each test file gets its own database cloned from it
 * (`test/setup-database.ts`), reached through `testPool()` and dropped after the file. A
 * database holds one Tenant, as in production, so every further test Tenant gets a database
 * of its own: `tenantTestDatabase()` (dropped after the file) or `isolatedTestDatabase()`
 * (dropped by the test).
 */
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import { stackEndpoints } from "../stack/endpoints.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The template database global setup migrated for this run. */
    templateDatabase: string;
    /** The prefix of every database this run clones from the template. */
    testDatabasePrefix: string;
  }
}

const APPLICATION_NAME = "nylorun-runtime-test";

/** The URL of database `name` on the test stack's server. */
export function testDatabaseUrl(name: string): string {
  const url = new URL(stackEndpoints().postgres.url);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh database name with `prefix`. */
export function newDatabaseName(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Runs `fn` on one connection to the server's maintenance database (`nylorun`). */
export async function onTestServer<T>(fn: (sql: PostgresClient) => Promise<T>): Promise<T> {
  const sql = createPostgresClient(stackEndpoints().postgres.url, {
    max: 1,
    applicationName: APPLICATION_NAME,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Creates a database cloned from the run's template and returns its name. */
export async function createTestDatabase(): Promise<string> {
  const template = inject("templateDatabase");
  if (!template)
    throw new Error("No template database: run the tests through runtime/vitest*.config.ts");
  const name = newDatabaseName(inject("testDatabasePrefix"));
  await onTestServer((sql) => sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`));
  return name;
}

/** Drops a test database, closing whatever is still connected to it. */
export async function dropTestDatabase(name: string): Promise<void> {
  await onTestServer((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

/** A pool on a test database. Idle connections close after a second. */
export function testDatabasePool(name: string, max = 5): PostgresClient {
  return createPostgresClient(testDatabaseUrl(name), {
    max,
    idleTimeoutSeconds: 1,
    applicationName: APPLICATION_NAME,
  });
}

let file:
  | { name: string; pool?: PostgresClient; extra: { name: string; pool: PostgresClient }[] }
  | undefined;

/** Creates this test file's database (`setup-database.ts`, before the file's tests). */
export async function openFileDatabase(): Promise<void> {
  file = { name: await createTestDatabase(), extra: [] };
}

/** Ends the file's pool and drops its database (`setup-database.ts`, after the file). */
export async function closeFileDatabase(): Promise<void> {
  const current = file;
  file = undefined;
  if (!current) return;
  await current.pool?.end({ timeout: 5 });
  await dropTestDatabase(current.name);
  for (const extra of current.extra) {
    await extra.pool.end({ timeout: 5 });
    await dropTestDatabase(extra.name);
  }
}

/**
 * Another database cloned from the template, for one more Tenant in this file. Dropped with
 * the file's database; `drop` drops it sooner.
 */
export async function tenantTestDatabase(): Promise<{
  name: string;
  sql: PostgresClient;
  url: string;
  drop(): Promise<void>;
}> {
  if (!file) throw new Error("This test file has no database (see test/setup-database.ts)");
  const owner = file;
  const name = await createTestDatabase();
  const sql = testDatabasePool(name);
  const entry = { name, pool: sql };
  owner.extra.push(entry);
  return {
    name,
    sql,
    url: testDatabaseUrl(name),
    async drop() {
      const index = owner.extra.indexOf(entry);
      if (index < 0) return;
      owner.extra.splice(index, 1);
      await sql.end({ timeout: 5 });
      await dropTestDatabase(name);
    },
  };
}

/**
 * A database with nothing in it (no schema migrated), for tests of migrations and of what a
 * Runtime does with a database it did not create. Dropped with the file's database.
 */
export async function emptyTestDatabase(): Promise<{ name: string; sql: PostgresClient; url: string }> {
  if (!file) throw new Error("This test file has no database (see test/setup-database.ts)");
  const name = newDatabaseName(inject("testDatabasePrefix"));
  await onTestServer((sql) => sql.unsafe(`CREATE DATABASE ${name}`));
  const sql = testDatabasePool(name);
  file.extra.push({ name, pool: sql });
  return { name, sql, url: testDatabaseUrl(name) };
}

/** The name of this test file's database. */
export function fileDatabaseName(): string {
  if (!file) throw new Error("This test file has no database (see test/setup-database.ts)");
  return file.name;
}

/** The pool on this test file's database (at most 5 connections). */
export function testPool(): PostgresClient {
  if (!file) throw new Error("This test file has no database (see test/setup-database.ts)");
  return (file.pool ??= testDatabasePool(file.name));
}

/**
 * Another database cloned from the template, for a Tenant the test drops itself. `drop` ends
 * its pool and drops it.
 */
export async function isolatedTestDatabase(): Promise<{
  sql: PostgresClient;
  url: string;
  drop(): Promise<void>;
}> {
  const name = await createTestDatabase();
  const sql = testDatabasePool(name);
  return {
    sql,
    url: testDatabaseUrl(name),
    async drop() {
      await sql.end({ timeout: 5 });
      await dropTestDatabase(name);
    },
  };
}
