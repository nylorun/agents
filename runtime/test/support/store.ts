/**
 * Test Tenants on Postgres: each is a schema `tenant_<id>` in the test file's own database
 * (`./database.ts`), created and opened through the Tenant catalog as a Host would.
 */
import { newTenantId } from "@nylorun/core/compatibility";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import {
  createPostgresTenantCatalog,
  type PostgresTenantCatalog,
} from "../../src/store/postgres/tenants.js";
import type { SessionStore } from "../../src/store/types.js";
import { testPool } from "./database.js";

export { isolatedTestDatabase, testPool } from "./database.js";

export function testCatalog(): PostgresTenantCatalog {
  return createPostgresTenantCatalog({ sql: testPool() });
}

/** Drops a test Tenant's schema. */
export async function dropTestTenant(tenantId: string): Promise<void> {
  await testCatalog().deleteTenant(tenantId);
}

/**
 * A second Session Store on a test Tenant's data, as another process would open it
 * (restart and ownership tests). `root` is the Host root.
 */
export async function openTestSessionStore(input: {
  root: string;
  tenantId: string;
}): Promise<SessionStore> {
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

/**
 * A new test Tenant and a Session Store on it, for tests that drive the store without a
 * Tenant Runtime. Its schema goes with the file's database.
 */
export async function createTestSessionStore(
  tenantId = newTenantId(),
): Promise<SessionStore> {
  await testCatalog().createTenant({
    envelope: testEnvelope(tenantId),
    principals: {
      principalId: "principal_test",
      credentialHash: "ab".repeat(32),
      idempotencyKey: `boot-${tenantId}`,
    },
  });
  return openTestSessionStore({ root: "", tenantId });
}

/** The envelope a test Tenant is created with. */
export function testEnvelope(tenantId: string, name = "test"): TenantEnvelope {
  const now = new Date().toISOString();
  return { id: tenantId, name, createdAt: now, updatedAt: now, schemaVersion: 1 };
}
