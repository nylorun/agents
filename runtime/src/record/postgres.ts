/**
 * The only insert into the shared record (Durable Streams §6, blueprint D27): the session's log
 * head allocates the next sequence, and the event row is written, both in the caller's
 * transaction. The caller holds the session row lock, which orders the session's appends, and
 * passes the epoch it read under that lock.
 */
import type { TransactionSql } from "postgres";
import type { EventPayload, EventType, SessionEventOf } from "@nylorun/core/contracts";
import { STREAMS_SCHEMA } from "../store/postgres/migrations/shared/index.js";
import { buildEvent } from "./envelope.js";

const SESSION_EVENTS = `${STREAMS_SCHEMA}.session_events`;
const LOG_HEADS = `${STREAMS_SCHEMA}.session_log_heads`;

export interface AppendInput<T extends EventType> {
  tenantId: string;
  /** The Tenant's schema: a session's first event takes its basin generation from there. */
  tenantSchema: string;
  sessionId: string;
  turnId: string | null;
  /** The session's ownership epoch, read under the caller's session row lock. */
  epoch: number;
  time: Date;
  type: T;
  payload: EventPayload<T>;
}

/**
 * Appends one event in `sql`'s transaction. An event the catalog does not describe throws
 * `InvalidEventError` before its row is written; the caller's transaction then rolls back.
 */
export async function appendEvent<T extends EventType>(
  sql: TransactionSql,
  input: AppendInput<T>,
): Promise<{ event: SessionEventOf<T>; generation: number }> {
  const [row] = await sql`
    INSERT INTO ${sql(LOG_HEADS)} (tenant_id, session_id, generation, head)
    VALUES (
      ${input.tenantId}, ${input.sessionId},
      coalesce((SELECT basin_generation FROM ${sql(`${input.tenantSchema}.tenant`)}), 0), 1)
    ON CONFLICT (tenant_id, session_id)
      DO UPDATE SET head = ${sql(LOG_HEADS)}.head + 1
    RETURNING head - 1 AS seq, generation`;
  const seq = Number(row!.seq);
  const generation = Number(row!.generation);
  const event = buildEvent({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    seq,
    epoch: input.epoch,
    time: input.time,
    type: input.type,
    payload: input.payload,
  });
  await sql`
    INSERT INTO ${sql(SESSION_EVENTS)} (tenant_id, session_id, seq, generation, type, body)
    VALUES (${input.tenantId}, ${input.sessionId}, ${seq}, ${generation}, ${input.type},
            ${JSON.stringify(event)}::text::json)`;
  return { event, generation };
}
