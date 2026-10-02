/**
 * The only write path into the record (Durable Streams §6, blueprint D27): the session's log
 * head allocates the next sequence, the event is built on the envelope and checked against the
 * catalog, and its row is written, both in the caller's transaction. The database holds one
 * Tenant, so rows are keyed by session alone; the Tenant id is the caller's and goes into the
 * envelope only. The caller holds the session row lock, which orders the session's appends,
 * and passes the epoch it read under that lock.
 *
 * The two statements run through `RecordWriter`, which the store implements on its
 * transaction (`store/postgres/record-writer.ts`): the database driver stays behind
 * `store/postgres/` (session-store.md §3), and this module decides what is written.
 */
import type { EventPayload, EventType, LiveEvent, SessionEventOf } from "@nylorun/core/contracts";
import { buildEvent } from "./envelope.js";

/** The record's two statements, in the caller's transaction. */
export interface RecordWriter {
  /**
   * Advances the session's log head: the seq its next event takes, and the basin generation
   * its events go to (a session's first event takes the Tenant's current one).
   */
  advance(sessionId: string): Promise<{ seq: number; generation: number }>;
  /** Writes the event's row. */
  insert(row: {
    sessionId: string;
    seq: number;
    generation: number;
    type: string;
    body: LiveEvent;
  }): Promise<void>;
}

export interface AppendInput<T extends EventType> {
  /** The database's one Tenant, for the envelope. */
  tenantId: string;
  sessionId: string;
  turnId: string | null;
  /** The session's ownership epoch, read under the caller's session row lock. */
  epoch: number;
  time: Date;
  type: T;
  payload: EventPayload<T>;
}

/**
 * Appends one event through `writer`. An event the catalog does not describe throws
 * `InvalidEventError` before its row is written; the caller's transaction then rolls back.
 */
export async function appendEvent<T extends EventType>(
  writer: RecordWriter,
  input: AppendInput<T>,
): Promise<{ event: SessionEventOf<T>; generation: number }> {
  const { seq, generation } = await writer.advance(input.sessionId);
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
  await writer.insert({ sessionId: input.sessionId, seq, generation, type: input.type, body: event });
  return { event, generation };
}
