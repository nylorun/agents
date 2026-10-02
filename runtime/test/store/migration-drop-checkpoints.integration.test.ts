/**
 * Migration 9 (blueprint P0.2): the write-only `checkpoints` table is dropped. Sessions and the
 * checkpoint each one resumes from (on the session row) are untouched.
 */
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  migrateSchema,
} from "../../src/store/postgres/migrations/index.js";
import { migrateStreamsSchema } from "../../src/store/postgres/migrations/shared/index.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/names.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { STACK_ENABLED } from "../stack/endpoints.js";
import { emptyTestDatabase } from "../support/database.js";

describe.skipIf(!STACK_ENABLED)("migration 9: drop checkpoints", () => {
  it("drops the table and keeps sessions with their checkpoints", async () => {
    // A Tenant database at migration 8, in a database of its own.
    const { sql } = await emptyTestDatabase();
    const tenantId = newTenantId();
    const schema = TENANT_SCHEMA;
    await migrateStreamsSchema(sql);
    await migrateSchema(sql, schema, MIGRATIONS.slice(0, 8));
    const now = new Date().toISOString();
    await sql`INSERT INTO ${sql(`${schema}.tenant`)} (id, name, created_at, updated_at, schema_version)
              VALUES (${tenantId}, 'Old', ${now}, ${now}, 8)`;
    const checkpoint = { version: 1, sessionId: "s1", turnId: "t1", segment: 2 };
    const session = { id: "s1", agentId: "a", status: "runnable", activeTurnId: "t1", checkpoint };
    await sql`INSERT INTO ${sql(`${schema}.sessions`)} (id, body)
              VALUES ('s1', ${JSON.stringify(session)}::text::json)`;
    await sql`INSERT INTO ${sql(`${schema}.checkpoints`)} (id, body)
              VALUES ('["s1","t1",2]', ${JSON.stringify({ checkpoint, status: "runnable" })}::text::json)`;

    expect(await migrateSchema(sql, schema)).toEqual({ from: 8, to: POSTGRES_SCHEMA_VERSION });
    expect(POSTGRES_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    const [table] = await sql`SELECT to_regclass(${`${schema}.checkpoints`}) AS t`;
    expect(table!.t).toBeNull();
    const store = createPostgresSessionStore({ sql, tenantId });
    try {
      const kept = await store.tx((t) => t.get<typeof session>("sessions", "s1"));
      expect(kept?.checkpoint).toEqual(checkpoint);
    } finally {
      await store.close();
    }
  });
});
