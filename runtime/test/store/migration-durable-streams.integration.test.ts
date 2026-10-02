/**
 * Migration 8 (Durable Streams §18.1): a Tenant with sessions starts fresh in basin generation
 * 1, with generation 0 retired; a Tenant without sessions stays at 0. The outbox and the
 * incarnation and sequence columns are gone.
 */
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  migrateSchema,
} from "../../src/store/postgres/migrations/index.js";
import {
  assertLogicalReplication,
  migrateStreamsSchema,
} from "../../src/store/postgres/migrations/shared/index.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/names.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import { STACK_ENABLED } from "../stack/endpoints.js";
import { emptyTestDatabase } from "../support/database.js";

describe.skipIf(!STACK_ENABLED)("migration 8: durable streams", () => {
  /**
   * A Tenant schema at migration 7 (as protocol 3 left one), with `sessions` sessions and their
   * outbox rows, in a database of its own.
   */
  async function protocol3Tenant(sessions: number) {
    const { sql } = await emptyTestDatabase();
    const tenantId = newTenantId();
    const schema = TENANT_SCHEMA;
    await migrateStreamsSchema(sql);
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
    return { sql, tenantId, schema };
  }

  it("starts a Tenant with sessions fresh in generation 1, keeping its settings", async () => {
    const { sql, tenantId, schema } = await protocol3Tenant(2);
    expect(await migrateSchema(sql, schema)).toEqual({ from: 7, to: POSTGRES_SCHEMA_VERSION });
    const store = createPostgresSessionStore({ sql, tenantId });
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
    const { sql, tenantId, schema } = await protocol3Tenant(0);
    await migrateSchema(sql, schema);
    const store = createPostgresSessionStore({ sql, tenantId });
    try {
      expect(await store.tx((t) => t.basinGenerations())).toEqual({ current: 0, retired: [] });
    } finally {
      await store.close();
    }
  });

  it("finds logical replication on the test stack", async () => {
    const { sql } = await emptyTestDatabase();
    await expect(assertLogicalReplication(sql)).resolves.toBeUndefined();
  });
});
