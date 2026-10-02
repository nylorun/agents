/**
 * Test databases on the test stack's Postgres (`test/stack/compose.yaml`; session-store.md §5).
 *
 * Global setup (`test/global-setup.ts`) migrates a template database once per run. Each test
 * file gets its own database cloned from it (`test/setup-database.ts`), reached through
 * `testPool()` and dropped after the file. A test that needs a Host of its own (one that must
 * see only its own Tenants) clones another one with `isolatedTestDatabase()`.
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

let file: { name: string; pool?: PostgresClient } | undefined;

/** Creates this test file's database (`setup-database.ts`, before the file's tests). */
export async function openFileDatabase(): Promise<void> {
  file = { name: await createTestDatabase() };
}

/** Ends the file's pool and drops its database (`setup-database.ts`, after the file). */
export async function closeFileDatabase(): Promise<void> {
  const current = file;
  file = undefined;
  if (!current) return;
  await current.pool?.end({ timeout: 5 });
  await dropTestDatabase(current.name);
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
 * Another database cloned from the template, for a test whose Host must see only its own
 * Tenants (listing, status). `drop` ends its pool and drops it.
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
