/**
 * The record's Postgres statements (Durable Streams §6), which the record module runs through
 * `RecordWriter` (`record/append.ts`, blueprint D27): the only inserts into `session_events`
 * and `session_log_heads`. They sit here, behind the driver boundary (session-store.md §3), and
 * run in the store's transaction under the caller's session row lock.
 */
import { eq, sql } from "drizzle-orm";
import type { RecordWriter, AgentRecordWriter, TenantRecordWriter } from "../../record/index.js";
import type { Transaction } from "./db.js";
import { agentEvents, sessionEvents, sessionLogHeads, tenant, tenantEvents } from "./schema.js";

/**
 * The Tenant stream's append lock: a transaction-level advisory lock, so appends take their seq
 * one at a time and in commit order. Distinct from the migration lock (`migrate.ts`).
 */
const TENANT_EVENTS_LOCK = sql`hashtext('nylorun.tenant_events')`;

/**
 * The Agent stream writer of transaction `db` (`record/agent.ts`): the only inserts into
 * `agent_events`. The caller holds the Agent row's lock, which orders its events.
 */
export function postgresAgentRecordWriter(db: Transaction): AgentRecordWriter {
  return {
    async nextSeq(agentId) {
      const [row] = await db
        .select({ next: sql<number>`coalesce(max(${agentEvents.seq}) + 1, 0)`.mapWith(Number) })
        .from(agentEvents)
        .where(eq(agentEvents.agentId, agentId));
      return row?.next ?? 0;
    },
    async insert(row) {
      await db.insert(agentEvents).values(row);
    },
  };
}

/**
 * The Tenant stream writer of transaction `db` (`record/tenant.ts`): the only inserts into
 * `tenant_events`. `nextSeq` takes the stream's append lock, held until `db` ends.
 */
export function postgresTenantRecordWriter(db: Transaction): TenantRecordWriter {
  return {
    async nextSeq() {
      await db.execute(sql`SELECT pg_advisory_xact_lock(${TENANT_EVENTS_LOCK})`);
      const [row] = await db
        .select({ next: sql<number>`coalesce(max(${tenantEvents.seq}) + 1, 0)`.mapWith(Number) })
        .from(tenantEvents);
      return row?.next ?? 0;
    },
    async insert(row) {
      await db.insert(tenantEvents).values(row);
    },
  };
}

/** The record writer of transaction `db`. */
export function postgresRecordWriter(db: Transaction): RecordWriter {
  return {
    async advance(sessionId) {
      const [row] = await db
        .insert(sessionLogHeads)
        .values({
          sessionId,
          generation: sql`coalesce((SELECT ${tenant.basinGeneration} FROM ${tenant}), 0)`,
          head: 1,
        })
        .onConflictDoUpdate({
          target: sessionLogHeads.sessionId,
          set: { head: sql`${sessionLogHeads.head} + 1` },
        })
        .returning({
          seq: sql<number>`${sessionLogHeads.head} - 1`.mapWith(Number),
          generation: sessionLogHeads.generation,
        });
      return row!;
    },
    async insert(row) {
      await db.insert(sessionEvents).values(row);
    },
  };
}
