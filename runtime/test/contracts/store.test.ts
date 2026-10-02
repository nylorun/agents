import { expect, it } from "vitest";
import { POSTGRES_SCHEMA_VERSION, migrateSchema } from "../../src/store/postgres/migrations/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { decodeCursor, encodeCursor } from "../../src/record/index.js";
import { createTestSessionStore, testPool } from "../support/store.js";
import { storeContract } from "./store.contract.js";

storeContract("postgres", async (options) => {
  const sql = testPool();
  const schema = tenantSchemaName(options.tenantId);
  await migrateSchema(sql, schema);
  // The Tenant's row, as the catalog writes it when it creates the Tenant.
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql(`${schema}.tenant`)} (id, name, created_at, updated_at, schema_version)
    VALUES (${options.tenantId}, 'Test', ${now}, ${now}, ${POSTGRES_SCHEMA_VERSION})`;
  return {
    store: createPostgresSessionStore({ ...options, sql, schema }),
    dispose: async () => {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    },
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
