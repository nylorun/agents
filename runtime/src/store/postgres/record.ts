/**
 * Reads the shared record back for the stream relay (Durable Streams §7.2–7.3): a session's
 * rows to refill a gap in S2, every log head to reconcile after a fresh slot, and a Tenant's
 * current basin generation to tell obsolete rows apart. Reads every Tenant's rows by design.
 */
import type { Sql } from "postgres";
import type { LogHead, RecordReader, RecordRow } from "../../streams/relay/types.js";
import { STREAMS_SCHEMA } from "./migrations/shared/index.js";
import { quoteIdentifier, tenantSchemaName } from "./names.js";

/** Every Tenant's record (the stream relay), or one Tenant's (`tenantId`, its Session Store). */
export function createPostgresRecordReader(
  sql: Sql,
  options: { tenantId?: string } = {},
): RecordReader {
  const only = options.tenantId;
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
          ${only === undefined ? sql`` : sql`AND tenant_id = ${only}`}
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
      let schema: string;
      try {
        schema = tenantSchemaName(tenantId);
      } catch {
        return undefined;
      }
      const [exists] = await sql<{ exists: boolean }[]>`
        SELECT to_regclass(${`${quoteIdentifier(schema)}.tenant`}) IS NOT NULL AS exists`;
      if (!exists?.exists) return undefined;
      try {
        const [row] = await sql<{ basin_generation: number }[]>`
          SELECT basin_generation FROM ${sql(`${schema}.tenant`)}`;
        // A schema without its Tenant row (store tests) is at generation 0.
        return row ? Number(row.basin_generation) : 0;
      } catch (error) {
        // Deleted between the two reads.
        if ((error as { code?: string }).code === "42P01") return undefined;
        throw error;
      }
    },
  };
}
