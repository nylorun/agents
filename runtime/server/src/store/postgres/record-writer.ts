/**
 * The record's Postgres statements (Durable Streams §6), which the record module runs through
 * `RecordWriter` (`record/append.ts`, blueprint D27): the only inserts into `session_events`
 * and `session_log_heads`. They sit here, behind the driver boundary (session-store.md §3), and
 * run in the store's transaction under the caller's session row lock.
 */
import { eq, sql } from "drizzle-orm";
import type { RecordWriter, EnvironmentRecordWriter } from "../../record/index.js";
import type { Transaction } from "./db.js";
import { environmentEvents, sessionEvents, sessionLogHeads, tenant } from "./schema.js";

/**
 * The Environment stream writer of transaction `db` (`record/environment.ts`): the only inserts
 * into `environment_events`. The caller holds the Environment row's lock, which orders its events.
 */
export function postgresEnvironmentRecordWriter(db: Transaction): EnvironmentRecordWriter {
  return {
    async nextSeq(environmentId) {
      const [row] = await db
        .select({ next: sql<number>`coalesce(max(${environmentEvents.seq}) + 1, 0)`.mapWith(Number) })
        .from(environmentEvents)
        .where(eq(environmentEvents.environmentId, environmentId));
      return row?.next ?? 0;
    },
    async insert(row) {
      await db.insert(environmentEvents).values(row);
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
