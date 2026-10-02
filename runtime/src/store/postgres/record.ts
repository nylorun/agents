/**
 * Reads the record back for the stream relay (Durable Streams §7.2–7.3): a session's rows to
 * refill a gap in S2, every log head to reconcile after a fresh slot, and the Tenant's current
 * basin generation to tell obsolete rows apart.
 *
 * The database holds one Tenant, so the record has no Tenant column: the reader is made for
 * that Tenant (`tenantId`), fills `RecordRow.tenantId` and `LogHead.tenantId` with it, and
 * reads nothing for any other id.
 */
import type { Sql } from "postgres";
import type { LogHead, RecordReader, RecordRow } from "../../streams/relay/types.js";
import { STREAMS_SCHEMA } from "./migrations/shared/index.js";
import { TENANT_SCHEMA } from "./names.js";

export function createPostgresRecordReader(
  sql: Sql,
  options: { tenantId: string },
): RecordReader {
  const own = options.tenantId;
  const events = sql(`${STREAMS_SCHEMA}.session_events`);
  const heads = sql(`${STREAMS_SCHEMA}.session_log_heads`);
  return {
    async readRange(tenantId, sessionId, from, to) {
      if (tenantId !== own) return [];
      const rows = await sql<{ seq: string; generation: number; body: unknown }[]>`
        SELECT seq, generation, body FROM ${events}
        WHERE session_id = ${sessionId} AND seq >= ${from} AND seq < ${to}
        ORDER BY seq`;
      return rows.map(
        (row): RecordRow => ({
          tenantId,
          sessionId,
          seq: Number(row.seq),
          generation: row.generation,
          body: row.body,
        }),
      );
    },

    async heads(after, limit) {
      // Heads are ordered by (Tenant, session): every one of this Tenant's comes after a
      // Tenant id that sorts before it, and none after one that sorts after it.
      if (after && after.tenantId > own) return [];
      const from = after?.tenantId === own ? after.sessionId : undefined;
      const rows = await sql<{ session_id: string; generation: number; head: string }[]>`
        SELECT session_id, generation, head FROM ${heads}
        WHERE head > 0
          ${from === undefined ? sql`` : sql`AND session_id > ${from}`}
        ORDER BY session_id
        LIMIT ${limit}`;
      return rows.map(
        (row): LogHead => ({
          tenantId: own,
          sessionId: row.session_id,
          generation: row.generation,
          head: Number(row.head),
        }),
      );
    },

    async generation(tenantId) {
      if (tenantId !== own) return undefined;
      const [row] = await sql<{ basin_generation: number }[]>`
        SELECT basin_generation FROM ${sql(`${TENANT_SCHEMA}.tenant`)}`;
      // A database whose Tenant row is not written yet is at generation 0.
      return row ? Number(row.basin_generation) : 0;
    },
  };
}
