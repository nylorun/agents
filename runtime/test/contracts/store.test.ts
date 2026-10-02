import { expect, it } from "vitest";
import { expectedSchemaVersion } from "../../src/store/postgres/migrate.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/schema.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { decodeCursor, encodeCursor } from "../../src/record/index.js";
import { createTestSessionStore, isolatedTestDatabase } from "../support/store.js";
import { storeContract } from "./store.contract.js";

// Each store is the one Tenant of a database of its own, cloned from the migrated template.
storeContract("postgres", async (options) => {
  const database = await isolatedTestDatabase();
  const { sql } = database;
  // The Tenant's row, as the bootstrap writes it when it creates the Tenant.
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql(`${TENANT_SCHEMA}.tenant`)} (id, name, created_at, updated_at, schema_version)
    VALUES (${options.tenantId}, 'Test', ${now}, ${now}, ${expectedSchemaVersion()})`;
  return {
    store: createPostgresSessionStore({ ...options, sql }),
    dispose: () => database.drop(),
  };
});

it("encodes cursors as base64url session:seq", () => {
  expect(encodeCursor("s1", 7)).toBe(Buffer.from("s1:7").toString("base64url"));
  expect(decodeCursor("s1", encodeCursor("s1", 7))).toBe(7);
  expect(() => decodeCursor("s2", encodeCursor("s1", 7))).toThrow("Invalid cursor");
  expect(() => decodeCursor("s1", Buffer.from("s1:x").toString("base64url"))).toThrow(
    "Invalid cursor",
  );
});

it("rejects transactions after close", async () => {
  const store = await createTestSessionStore();
  await store.close();
  await expect(store.tx(async () => 1)).rejects.toThrow("closed");
});
