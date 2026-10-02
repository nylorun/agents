/**
 * Migration 9 (blueprint P0.2): the write-only `checkpoints` table is dropped. Sessions and the
 * checkpoint each one resumes from (on the session row) are untouched.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresClient } from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  migrateSchema,
} from "../../src/store/postgres/migrations/index.js";
import { migrateStreamsSchema } from "../../src/store/postgres/migrations/shared/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

describe.skipIf(!STACK_ENABLED)("migration 9: drop checkpoints", () => {
  const sql = createPostgresClient(stackEndpoints().postgres.url, { max: 4 });
  const schemas: string[] = [];
  afterAll(async () => {
    for (const schema of schemas) await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it("drops the table and keeps sessions with their checkpoints", async () => {
    await migrateStreamsSchema(sql);
    const tenantId = `tn_${randomBytes(13).toString("hex").slice(0, 26)}`;
    const schema = tenantSchemaName(tenantId);
    schemas.push(schema);
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
    const store = createPostgresSessionStore({ sql, tenantId, schema });
    try {
      const kept = await store.tx((t) => t.get<typeof session>("sessions", "s1"));
      expect(kept?.checkpoint).toEqual(checkpoint);
    } finally {
      await store.close();
    }
  });
});
