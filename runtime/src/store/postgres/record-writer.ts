/**
 * The record's Postgres statements (Durable Streams §6), which the record module runs through
 * `RecordWriter` (`record/append.ts`, blueprint D27): the only inserts into `session_events`
 * and `session_log_heads`. They sit here, behind the driver boundary (session-store.md §3), and
 * run in the store's transaction under the caller's session row lock.
 */
import { sql } from "drizzle-orm";
import type { RecordWriter } from "../../record/index.js";
import type { Transaction } from "./db.js";
import { sessionEvents, sessionLogHeads, tenant } from "./schema.js";

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
