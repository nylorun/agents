/**
 * Reads the record back for the stream relay (Durable Streams §7.2–7.3): a session's rows to
 * refill a gap in S2, every log head to reconcile after a fresh slot, and the Tenant's current
 * basin generation to tell obsolete rows apart.
 *
 * The database holds one Tenant, so the record has no Tenant column: the reader is made for
 * that Tenant (`tenantId`), fills `RecordRow.tenantId` and `LogHead.tenantId` with it, and
 * reads nothing for any other id.
 */
import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import type { Sql } from "postgres";
import type { LogHead, RecordReader, RecordRow } from "../../streams/relay/types.js";
import { database, driverError } from "./db.js";
import { sessionEvents, sessionLogHeads, tenant } from "./schema.js";

export function createPostgresRecordReader(
  sql: Sql,
  options: { tenantId: string },
): RecordReader {
  const own = options.tenantId;
  const db = database(sql);
  const read = <T>(query: PromiseLike<T>): Promise<T> =>
    Promise.resolve(query).catch((error: unknown) => {
      throw driverError(error);
    });
  return {
    async readRange(tenantId, sessionId, from, to) {
      if (tenantId !== own) return [];
      const rows = await read(
        db
          .select({
            seq: sessionEvents.seq,
            generation: sessionEvents.generation,
            body: sessionEvents.body,
          })
          .from(sessionEvents)
          .where(
            and(
              eq(sessionEvents.sessionId, sessionId),
              gte(sessionEvents.seq, from),
              lt(sessionEvents.seq, to),
            ),
          )
          .orderBy(asc(sessionEvents.seq)),
      );
      return rows.map((row): RecordRow => ({ tenantId, sessionId, ...row }));
    },

    async heads(after, limit) {
      // Heads are ordered by (Tenant, session): every one of this Tenant's comes after a
      // Tenant id that sorts before it, and none after one that sorts after it.
      if (after && after.tenantId > own) return [];
      const from = after?.tenantId === own ? after.sessionId : undefined;
      const rows = await read(
        db
          .select({
            sessionId: sessionLogHeads.sessionId,
            generation: sessionLogHeads.generation,
            head: sessionLogHeads.head,
          })
          .from(sessionLogHeads)
          .where(
            and(
              gt(sessionLogHeads.head, 0),
              from === undefined ? undefined : gt(sessionLogHeads.sessionId, from),
            ),
          )
          .orderBy(asc(sessionLogHeads.sessionId))
          .limit(limit),
      );
      return rows.map((row): LogHead => ({ tenantId: own, ...row }));
    },

    async generation(tenantId) {
      if (tenantId !== own) return undefined;
      const [row] = await read(
        db.select({ generation: tenant.basinGeneration }).from(tenant),
      );
      // A database whose Tenant row is not written yet is at generation 0.
      return row?.generation ?? 0;
    },
  };
}
