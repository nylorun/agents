/**
 * Reads the shared record back for the stream relay (Durable Streams §7.2–7.3): a session's
 * rows to refill a gap in S2, every log head to reconcile after a fresh slot, and a Tenant's
 * current basin generation to tell obsolete rows apart. Reads every Tenant's rows by design.
 */
import type { Sql } from "postgres";
import type { LogHead, RecordReader, RecordRow } from "../../streams/relay/types.js";
import { STREAMS_SCHEMA } from "./migrations/shared/index.js";
import { quoteIdentifier, tenantSchemaName } from "./names.js";

export function createPostgresRecordReader(sql: Sql): RecordReader {
  const events = sql(`${STREAMS_SCHEMA}.session_events`);
  const heads = sql(`${STREAMS_SCHEMA}.session_log_heads`);
  return {
    async readRange(tenantId, sessionId, from, to) {
      const rows = await sql<{ seq: string; generation: number; body: unknown }[]>`
        SELECT seq, generation, body FROM ${events}
        WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
          AND seq >= ${from} AND seq < ${to}
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
      const rows = await sql<{ tenant_id: string; session_id: string; generation: number; head: string }[]>`
        SELECT tenant_id, session_id, generation, head FROM ${heads}
        WHERE head > 0
          ${after ? sql`AND (tenant_id, session_id) > (${after.tenantId}, ${after.sessionId})` : sql``}
        ORDER BY tenant_id, session_id
        LIMIT ${limit}`;
      return rows.map(
        (row): LogHead => ({
          tenantId: row.tenant_id,
          sessionId: row.session_id,
          generation: row.generation,
          head: Number(row.head),
        }),
      );
    },

    async generation(tenantId) {
      const table = `${quoteIdentifier(tenantSchemaName(tenantId))}.tenant`;
      const [row] = await sql<{ exists: boolean }[]>`
        SELECT to_regclass(${table}) IS NOT NULL AS exists`;
      return row?.exists ? 0 : undefined;
    },
  };
}
