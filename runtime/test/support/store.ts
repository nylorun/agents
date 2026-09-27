/**
 * Which Session Store runtime tests run a Tenant on, from `NYLORUN_TEST_STORE`:
 *
 * - `memory` (default): the in-memory Session Store (`src/store/memory.ts`), whose data this
 *   module keeps per Tenant id so a restarted Tenant (or a second store, as another process
 *   would open it) finds it again. No Docker needed.
 * - `postgres`: a fresh schema `tenant_<id>` in the test stack's Postgres
 *   (`test/stack/endpoints.ts`; bring the stack up first). Tests share one pool per worker.
 *
 *   NYLORUN_TEST_STORE=postgres NYLORUN_TEST_STACK=1 npx vitest run   # in runtime/
 */
import { randomBytes } from "node:crypto";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import {
  createPostgresTenantCatalog,
  type PostgresTenantCatalog,
} from "../../src/store/postgres/tenants.js";
import { MemorySessionStore, MemoryStoreData } from "../../src/store/memory.js";
import type { SessionStore } from "../../src/store/types.js";
import { stackEndpoints } from "../stack/endpoints.js";

export type TestStore = "memory" | "postgres";

export const TEST_STORE: TestStore =
  process.env.NYLORUN_TEST_STORE === "postgres" ? "postgres" : "memory";

/** The data of each memory test Tenant, by Tenant id, until `dropTestTenant`. */
const memoryTenants = new Map<string, MemoryStoreData>();

/** Whether a memory test Tenant exists. */
export function memoryTenantExists(tenantId: string): boolean {
  return memoryTenants.has(tenantId);
}

/** A memory test Tenant's data, created empty on first use. */
export function memoryTenantData(tenantId: string): MemoryStoreData {
  let data = memoryTenants.get(tenantId);
  if (!data) memoryTenants.set(tenantId, (data = new MemoryStoreData()));
  return data;
}

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

/** Drops a test Tenant's data: its Postgres schema, or its memory data. */
export async function dropTestTenant(tenantId: string): Promise<void> {
  if (TEST_STORE === "postgres") await testCatalog().deleteTenant(tenantId);
  else memoryTenants.delete(tenantId);
}

/**
 * A second Session Store on a test Tenant's data, as another process would open it
 * (restart and ownership tests). `root` is the Host root.
 */
export async function openTestSessionStore(input: {
  root: string;
  tenantId: string;
}): Promise<SessionStore> {
  if (TEST_STORE === "memory") {
    if (!memoryTenantExists(input.tenantId))
      throw new Error(`Test Tenant ${input.tenantId} does not exist`);
    return new MemorySessionStore(
      { tenantId: input.tenantId },
      memoryTenantData(input.tenantId),
    );
  }
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

/** The envelope a test Tenant is created with. */
export function testEnvelope(tenantId: string, name = "test"): TenantEnvelope {
  const now = new Date().toISOString();
  return { id: tenantId, name, createdAt: now, updatedAt: now, schemaVersion: 1 };
}
