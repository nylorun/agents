/**
 * Writing the shared record directly (as `Tx.event` does) and reading it back, for stream
 * relay tests on the test stack's Postgres.
 */
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { createPostgresRecordReader } from "../../src/store/postgres/record.js";
import type { RecordReader, RecordRow } from "../../src/streams/relay/types.js";

/** One transaction appending `n` events to a session: log head, then rows. Returns their seqs. */
export async function writeRecord(
  sql: PostgresClient,
  tenantId: string,
  sessionId: string,
  n = 1,
  body: (seq: number) => unknown = (seq) => ({ sessionId, seq }),
): Promise<number[]> {
  return sql.begin(async (tx) => {
    const seqs: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const [head] = await tx<{ seq: string }[]>`
        INSERT INTO nylorun_streams.session_log_heads (tenant_id, session_id, generation, head)
        VALUES (${tenantId}, ${sessionId}, 0, 1)
        ON CONFLICT (tenant_id, session_id)
          DO UPDATE SET head = nylorun_streams.session_log_heads.head + 1
        RETURNING head - 1 AS seq`;
      const seq = Number(head!.seq);
      seqs.push(seq);
      await tx`
        INSERT INTO nylorun_streams.session_events
          (tenant_id, session_id, seq, generation, type, body)
        VALUES (${tenantId}, ${sessionId}, ${seq}, 0, 'turn.completed',
                ${JSON.stringify(body(seq))}::text::json)`;
    }
    return seqs;
  }) as Promise<number[]>;
}

/**
 * The record of `tenantId` only: other Tenants' rows on the shared publication (other tests)
 * read as Tenants that are gone, so a relay drops them.
 */
export function recordOf(sql: PostgresClient, tenantId: string): RecordReader {
  const reader = createPostgresRecordReader(sql, { tenantId });
  return {
    readRange: (...args) => reader.readRange(...args),
    heads: (...args) => reader.heads(...args),
    generation: async (id) => (id === tenantId ? 0 : undefined),
  };
}

/** Every row of `tenantId`'s record, by session. */
export async function recordedRows(
  sql: PostgresClient,
  tenantId: string,
): Promise<Map<string, RecordRow[]>> {
  const reader = recordOf(sql, tenantId);
  const out = new Map<string, RecordRow[]>();
  for (const head of await reader.heads(undefined, 10_000))
    out.set(head.sessionId, await reader.readRange(tenantId, head.sessionId, 0, head.head));
  return out;
}
