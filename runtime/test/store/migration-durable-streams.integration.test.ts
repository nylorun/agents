/**
 * Migration 8 (Durable Streams §18.1): a Tenant with sessions starts fresh in basin generation
 * 1, with generation 0 retired; a Tenant without sessions stays at 0. The outbox and the
 * incarnation and sequence columns are gone.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresClient } from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  migrateSchema,
} from "../../src/store/postgres/migrations/index.js";
import {
  assertLogicalReplication,
  migrateStreamsSchema,
} from "../../src/store/postgres/migrations/shared/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

describe.skipIf(!STACK_ENABLED)("migration 8: durable streams", () => {
  const sql = createPostgresClient(stackEndpoints().postgres.url, { max: 4 });
  const schemas: string[] = [];
  afterAll(async () => {
    for (const schema of schemas) await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  /** A Tenant schema as protocol 3 left it, with `sessions` sessions and their outbox rows. */
  async function protocol3Tenant(sessions: number) {
    const tenantId = `tn_${randomBytes(13).toString("hex").slice(0, 26)}`;
    const schema = tenantSchemaName(tenantId);
    schemas.push(schema);
    await migrateSchema(sql, schema, MIGRATIONS.slice(0, 7));
    const now = new Date().toISOString();
    await sql`INSERT INTO ${sql(`${schema}.tenant`)} (id, name, created_at, updated_at, schema_version)
              VALUES (${tenantId}, 'Old', ${now}, ${now}, 7)`;
    for (let i = 0; i < sessions; i += 1) {
      const id = `s${i}`;
      await sql`INSERT INTO ${sql(`${schema}.sessions`)} (id, body)
                VALUES (${id}, ${JSON.stringify({ id, agentId: "a", status: "idle", activeTurnId: null, streamIncarnation: "abc" })}::text::json)`;
      await sql`INSERT INTO ${sql(`${schema}.outbox`)} (session_id, seq, body)
                VALUES (${id}, 0, ${JSON.stringify({ createdAt: now })}::text::json)`;
    }
    await sql`INSERT INTO ${sql(`${schema}.tenant_settings`)} (key, value) VALUES ('kept', 'yes')`;
    return { tenantId, schema };
  }

  it("starts a Tenant with sessions fresh in generation 1, keeping its settings", async () => {
    await migrateStreamsSchema(sql);
    const { tenantId, schema } = await protocol3Tenant(2);
    expect(await migrateSchema(sql, schema)).toEqual({ from: 7, to: POSTGRES_SCHEMA_VERSION });
    const store = createPostgresSessionStore({ sql, tenantId, schema });
    try {
      expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 1, retired: [0] });
      expect(await store.tx((t) => t.counts())).toMatchObject({ sessions: 0 });
      expect(await store.tx((t) => t.getSetting("kept"))).toBe("yes");
      const [outbox] = await sql`SELECT to_regclass(${`${schema}.outbox`}) AS t`;
      expect(outbox!.t).toBeNull();
      const columns = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'sessions'`;
      expect(columns.map((c) => c.column_name)).not.toContain("stream_incarnation");
      expect(columns.map((c) => c.column_name)).not.toContain("next_event_seq");
      // A session created again with an old id starts at 0 in the new generation.
      await store.tx((t) => t.put("sessions", "s0", { id: "s0", agentId: "a", status: "idle", activeTurnId: null }));
      const event = await store.tx((t) => t.event("s0", null, "turn.completed", { output: 1 }));
      expect(event.seq).toBe(0);
      expect(await store.record().heads(undefined, 10)).toEqual([
        { tenantId, sessionId: "s0", generation: 1, head: 1 },
      ]);
    } finally {
      await store.close();
    }
  });

  it("leaves a Tenant without sessions at generation 0", async () => {
    const { tenantId, schema } = await protocol3Tenant(0);
    await migrateSchema(sql, schema);
    const store = createPostgresSessionStore({ sql, tenantId, schema });
    try {
      expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 0, retired: [] });
    } finally {
      await store.close();
    }
  });

  it("finds logical replication on the test stack", async () => {
    await expect(assertLogicalReplication(sql)).resolves.toBeUndefined();
  });
});
