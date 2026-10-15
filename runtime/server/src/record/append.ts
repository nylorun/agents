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
 *
 * Every entry is held to the Tenant's Runtime limit `recordEntryBytes`, which the caller reads
 * and passes: an event whose payload is larger is refused (`RecordEntryTooLargeError`) before
 * anything is written, whoever wrote it, so no record reaches S2 past its 1 MiB.
 */
import {
  limitExceededMessage,
  type EventPayload,
  type EventType,
  type EventWriter,
  type LiveEvent,
  type SessionEventOf,
} from "@nylorun/core/contracts";
import { buildEvent } from "./envelope.js";

/**
 * An entry larger than the Tenant's `recordEntryBytes`: `limit_exceeded`, `413` to an API client
 * and the Harness API error code to a harness.
 */
export class RecordEntryTooLargeError extends Error {
  readonly code = "limit_exceeded" as const;
  readonly status = 413;
  readonly rejection: {
    readonly code: "limit_exceeded";
    readonly details: { readonly limit: "recordEntryBytes"; readonly bytes: number; readonly maxBytes: number };
  };
  constructor(
    /** What was refused, as the message names it: "The message.user event's payload". */
    what: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(limitExceededMessage(what, bytes, "recordEntryBytes", maxBytes));
    this.name = "RecordEntryTooLargeError";
    this.rejection = { code: "limit_exceeded", details: { limit: "recordEntryBytes", bytes, maxBytes } };
  }
}

/** The JSON size of an entry, in bytes: what the record holds of it. */
export function entryBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/** Throws `RecordEntryTooLargeError` when `entry` is larger than `maxBytes`; `what` names it. */
export function checkEntry(what: string, entry: unknown, maxBytes: number): void {
  const bytes = entryBytes(entry);
  if (bytes > maxBytes) throw new RecordEntryTooLargeError(what, bytes, maxBytes);
}

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
  /** Who wrote it (R4.9). */
  writer?: EventWriter;
  /** The Tenant's Runtime limit `recordEntryBytes`: the most bytes the payload may hold, as JSON. */
  maxEntryBytes: number;
}

/**
 * Appends one event through `writer`. An event the catalog does not describe throws
 * `InvalidEventError`, and one past `maxEntryBytes` `RecordEntryTooLargeError`, before its row is
 * written; the caller's transaction then rolls back.
 */
export async function appendEvent<T extends EventType>(
  writer: RecordWriter,
  input: AppendInput<T>,
): Promise<{ event: SessionEventOf<T>; generation: number }> {
  checkEntry(`The ${input.type} event's payload`, input.payload, input.maxEntryBytes);
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
    ...(input.writer ? { writer: input.writer } : {}),
  });
  await writer.insert({ sessionId: input.sessionId, seq, generation, type: input.type, body: event });
  return { event, generation };
}
