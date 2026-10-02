/**
 * Test Tenants on Postgres: each is the one Tenant of a database of its own (`./database.ts`),
 * created and opened through the Tenant bootstrap (`store/postgres/tenant.ts`) as a Host
 * would. The databases go with the test file's.
 */
import { newTenantId } from "@nylorun/core/compatibility";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import {
  openTenantDatabase,
  type InitialPrincipal,
  type OpenedTenantDatabase,
} from "../../src/store/postgres/tenant.js";
import type { SessionStore } from "../../src/store/types.js";
import { tenantTestDatabase } from "./database.js";

export { isolatedTestDatabase, tenantTestDatabase, testPool } from "./database.js";

/** The database of each test Tenant of this file, by Tenant id. */
const databases = new Map<string, { sql: PostgresClient; drop(): Promise<void> }>();

/** The pool on a test Tenant's database. Throws for a Tenant this file did not create. */
export function testTenantPool(tenantId: string): PostgresClient {
  const database = databases.get(tenantId);
  if (!database) throw new Error(`Test Tenant ${tenantId} has no database in this file`);
  return database.sql;
}

/**
 * The database of test Tenant `tenantId`: the one it was created in, or a new one (its
 * Tenant is created when it is first opened).
 */
export async function testTenantDatabase(tenantId: string): Promise<PostgresClient> {
  const existing = databases.get(tenantId);
  if (existing) return existing.sql;
  const created = await tenantTestDatabase();
  databases.set(tenantId, created);
  return created.sql;
}

/** Drops a test Tenant's database. */
export async function dropTestTenant(tenantId: string): Promise<void> {
  const database = databases.get(tenantId);
  databases.delete(tenantId);
  await database?.drop();
}

/**
 * Opens test Tenant `tenantId` as a Host would: migrates its database, creates the Tenant on
 * first use (with `principals`), and opens its Session Store.
 */
export async function openTestTenant(
  tenantId: string,
  options: {
    principals?: readonly InitialPrincipal[];
    name?: string;
    onError?: (error: unknown) => void;
  } = {},
): Promise<OpenedTenantDatabase> {
  return openTenantDatabase({
    sql: await testTenantDatabase(tenantId),
    create: {
      tenantId,
      name: options.name ?? "test",
      principals: () => options.principals ?? [],
    },
    ...(options.onError ? { onError: options.onError } : {}),
  });
}

/**
 * A second Session Store on a test Tenant's data, as another process would open it
 * (restart and ownership tests). `root` is the Host root.
 */
export async function openTestSessionStore(input: {
  root: string;
  tenantId: string;
}): Promise<SessionStore> {
  if (!databases.has(input.tenantId))
    throw new Error(`Test Tenant ${input.tenantId} has no database in this file`);
  return (await openTestTenant(input.tenantId)).store;
}

/** Runs `fn` on a test Tenant's store and closes it. */
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

/**
 * A new test Tenant, in a database of its own, and a Session Store on it, for tests that drive
 * the store without a Tenant Runtime.
 */
export async function createTestSessionStore(
  tenantId = newTenantId(),
): Promise<SessionStore> {
  const opened = await openTestTenant(tenantId, {
    principals: [{ id: "principal_test", credentialHash: "ab".repeat(32) }],
  });
  return opened.store;
}
