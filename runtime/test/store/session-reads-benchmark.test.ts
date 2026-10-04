/** Opt-in evidence on the disposable Postgres fixture, never a configured Tenant database. */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { createPostgresReadStore } from "../../src/store/postgres/reads.js";
import { database } from "../../src/store/postgres/db.js";
import { postgresRecordWriter } from "../../src/store/postgres/record-writer.js";
import { appendEvent } from "../../src/record/index.js";
import { pgSchema, text, json } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { emptyTestDatabase } from "../support/database.js";

it.skipIf(!process.env.SESSION_READS_EVIDENCE)(
  "records migration write timings and representative read plans",
  async () => {
    const db = await emptyTestDatabase();
    const tenantId = newTenantId();
    const options = { sql: db.sql, create: { tenantId, name: "benchmark", principals: () => [] } };
    const old = await openTenantDatabase({
      ...options,
      migrations: shippedMigrations().slice(0, -1),
    });
    await db.sql`insert into nylorun.sessions (id,body) select 's-' || lpad(n::text,6,'0'), json_build_object('agentId','bot','ownerUserId','bench','status','idle','lastTurnId',null) from generate_series(1,5000) n`;
    await db.sql`insert into nylorun.model_usage (id,effect_key,session_id,turn_id,agent_id,input_tokens,output_tokens,total_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,cost_usd,duplicate,created_at)
    select 'c-' || lpad(n::text,6,'0'), 'e-' || n, 's-000001', 't-' || n, 'bot', 10,5,15,0,0,0,0.001,false,'2026-01-01T00:00:00.000Z' from generate_series(1,20000) n`;
    const projection = pgSchema("nylorun").table("sessions", {
      id: text().primaryKey(),
      body: json().$type<Record<string, unknown>>().notNull(),
    });
    async function writes() {
      const samples: number[] = [];
      for (let n = 0; n < 120; n++) {
        const start = performance.now();
        await database(db.sql).transaction(async (tx) => {
          const [session] = await tx
            .select()
            .from(projection)
            .where(eq(projection.id, "s-000001"))
            .for("update");
          await tx
            .update(projection)
            .set({ body: { ...session!.body, lastTurnId: `turn-${n}` } })
            .where(eq(projection.id, "s-000001"));
          await appendEvent(postgresRecordWriter(tx), {
            tenantId,
            sessionId: "s-000001",
            turnId: `turn-${n}`,
            epoch: 0,
            time: new Date(),
            type: "turn.completed",
            payload: { output: {} },
          });
        });
        if (n >= 20) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return { samples: samples.length, medianMs: samples[50], p95Ms: samples[95] };
    }
    const before = await writes();
    await old.store.close();
    const start = performance.now();
    const next = await openTenantDatabase(options);
    const migrationMs = performance.now() - start;
    const after = await writes();
    // A mix of legacy nulls and new creation timestamps, with ties.
    await db.sql`update nylorun.sessions set created_at = '2026-01-01'::timestamptz + ((substring(id from 3)::int / 10) * interval '1 second') where substring(id from 3)::int > 1000`;
    await db.sql`analyze nylorun.sessions`;
    await db.sql`analyze nylorun.model_usage`;
    const queries = {
      sessions: `select id,created_at,(select e.committed_at from nylorun_streams.session_events e where e.session_id=s.id order by seq desc limit 1) as last_event_at from nylorun.sessions s order by created_at desc nulls last,id desc limit 51`,
      sessionsDeep: `select id,created_at from nylorun.sessions where created_at < '2026-01-01T00:04:00Z' or (created_at = '2026-01-01T00:04:00Z' and id < 's-002400') or created_at is null order by created_at desc nulls last,id desc limit 51`,
      usage: `select sum(total_tokens),sum(cost_usd) from nylorun.model_usage where session_id='s-000001'`,
      calls: `select * from nylorun.model_usage where session_id='s-000001' and (created_at,id)>('2026-01-01T00:00:00.000Z','c-010000') order by created_at,id limit 51`,
      export: `select * from nylorun.model_usage where txid < pg_snapshot_xmin(pg_current_snapshot()) order by txid,id limit 201`,
    };
    const plans: Record<string, unknown> = {};
    for (const [name, query] of Object.entries(queries))
      plans[name] = (await db.sql.unsafe(`explain (analyze,buffers,format json) ${query}`))[0]![
        "QUERY PLAN"
      ];
    const reads = createPostgresReadStore(db.sql, tenantId);
    try {
      let cursor: string | undefined;
      let count = 0;
      let pages = 0;
      do {
        const page = await reads.sessions({}, { limit: 200, cursor }, {});
        count += page.sessions.length;
        pages++;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(count).toBe(5000);
      expect(pages).toBe(25);
      writeFileSync(
        process.env.SESSION_READS_EVIDENCE!,
        JSON.stringify(
          {
            fixture: { sessions: 5000, ledgerRows: 20000, sessionPages: pages },
            postgres: (await db.sql`select version()`)[0]!.version,
            migrationMs,
            writes: { before, after },
            plans,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await reads.close();
      await next.store.close();
    }
  },
  30_000,
);
