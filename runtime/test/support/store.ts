/**
 * Which Session Store runtime tests run a Tenant on, from `NYLORUN_TEST_STORE`:
 *
 * - `sqlite` (default): `tenants/<id>/tenant.sqlite` under the test's Host root.
 * - `postgres`: a fresh schema `tenant_<id>` in the test stack's Postgres
 *   (`test/stack/endpoints.ts`; bring the stack up first). Tests share one pool per worker.
 *
 *   NYLORUN_TEST_STORE=postgres NYLORUN_TEST_STACK=1 npm test -w @nylorun/runtime
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import {
  createPostgresTenantCatalog,
  type PostgresTenantCatalog,
} from "../../src/store/postgres/tenants.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import type { SessionStore } from "../../src/store/types.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import type { DurableStreams } from "../../src/streams/types.js";
import { stackEndpoints } from "../stack/endpoints.js";

export type TestStore = "sqlite" | "postgres";

export const TEST_STORE: TestStore =
  process.env.NYLORUN_TEST_STORE === "postgres" ? "postgres" : "sqlite";

let pool: PostgresClient | undefined;

/** The worker's pool on the test stack. Idle connections close after a second. */
export function testPool(): PostgresClient {
  pool ??= createPostgresClient(stackEndpoints().postgres.url, {
    max: 20,
    idleTimeoutSeconds: 1,
    applicationName: "nylorun-runtime-test",
  });
  return pool;
}

/**
 * A fresh database on the test stack's server, for a test whose Host must see only its own
 * Tenants (listing, status). `drop` ends its pool and drops it.
 */
export async function isolatedTestDatabase(): Promise<{
  sql: PostgresClient;
  drop(): Promise<void>;
}> {
  const name = `nylorun_test_${randomBytes(8).toString("hex")}`;
  await testPool().unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(stackEndpoints().postgres.url);
  url.pathname = `/${name}`;
  const sql = createPostgresClient(url.toString(), {
    max: 10,
    idleTimeoutSeconds: 1,
    applicationName: "nylorun-runtime-test",
  });
  return {
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      await testPool().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export function testCatalog(): PostgresTenantCatalog {
  return createPostgresTenantCatalog({ sql: testPool() });
}

/** Drops a Postgres Tenant's schema; a no-op for SQLite (its file goes with the root). */
export async function dropTestTenant(tenantId: string): Promise<void> {
  if (TEST_STORE === "postgres") await testCatalog().deleteTenant(tenantId);
}

/**
 * A second Session Store on a test Tenant's data, as another process would open it
 * (restart and ownership tests). `root` is the Host root.
 */
export async function openTestSessionStore(input: {
  root: string;
  tenantId: string;
}): Promise<SessionStore> {
  if (TEST_STORE === "sqlite")
    return createSqliteSessionStore({
      path: join(input.root, "tenants", input.tenantId, "tenant.sqlite"),
      tenantId: input.tenantId,
    });
  const opened = await testCatalog().openTenant(input.tenantId);
  if (opened.status !== "ok")
    throw new Error(`Test Tenant ${input.tenantId} is ${opened.status}`);
  return opened.store;
}

/** Runs `fn` in one transaction on a test Tenant's store and closes it. */
export async function withTestSessionStore<T>(
  input: { root: string; tenantId: string },
  fn: (store: SessionStore) => Promise<T>,
): Promise<T> {
  const store = await openTestSessionStore(input);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

const streams = new Map<string, MemoryStreams>();

/**
 * In-memory Durable Streams for a test Tenant, kept per Tenant id for the worker's life so
 * a reopened Tenant (restart tests) finds its history, as it would in S2.
 */
export function testStreams(tenantId: string): DurableStreams {
  let found = streams.get(tenantId);
  if (!found) streams.set(tenantId, (found = new MemoryStreams()));
  return found;
}

/** The envelope a test Tenant is created with. */
export function testEnvelope(tenantId: string, name = "test"): TenantEnvelope {
  const now = new Date().toISOString();
  return { id: tenantId, name, createdAt: now, updatedAt: now, schemaVersion: 1 };
}
