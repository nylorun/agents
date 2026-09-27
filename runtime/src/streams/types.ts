/**
 * The Durable Streams seam (architecture §12.4).
 *
 * Durable Streams tell everyone else what the Session Store recorded. Each
 * Tenant has one S2 basin; inside it:
 *
 * | Stream | Contents | Written by | Read by |
 * | --- | --- | --- | --- |
 * | `sessions/<sessionId>` | every `LiveEvent` of the session, in sequence | the relay, from the outbox | history and session SSE |
 * | `tenant/work` | `work_available` signals | API nodes and Workers after committing pending Actions | executor SSE on every API node |
 * | `tenant/control` | `session.cancel` signals | API nodes | Workers owning a session in the Tenant |
 *
 * S2 is the supported implementation (`adapters/streams/s2.ts`, the only file
 * importing the S2 SDK); `streams/memory.ts` is the in-memory fake.
 *
 * ## Guarantees every implementation keeps
 *
 * - **Sequence numbers.** Each stream numbers its records from 0 without gaps.
 *   The tail is the sequence the next appended record gets (0 for a stream
 *   that does not exist yet).
 * - **Conditional appends.** With `matchSeq`, a batch is appended only when the
 *   tail equals `matchSeq`; otherwise nothing is written and the result is a
 *   `SeqMismatch` carrying the current tail. The relay appends
 *   `sessions/<id>` with `matchSeq` set to the outbox row's sequence, so a
 *   retried append after an unacknowledged success is detected and never
 *   duplicated.
 * - **Batches are atomic.** A batch is appended entirely or not at all.
 * - **Reads resume.** `read` from `fromSeq` yields every record with
 *   `seq >= fromSeq` in order, with no gap between history and the live tail.
 * - **Tenant scope.** `ensureTenant` creates the Tenant's basin (idempotent)
 *   and must run before appends; streams are created on first append.
 *   `deleteTenant` removes the basin and every stream in it.
 * - **Records are JSON.** Bodies are JSON-serializable values; implementations
 *   encode them as they need.
 */

/** A record as read from a stream. */
export interface StreamRecord<T = unknown> {
  seq: number;
  /** Milliseconds since the epoch, as assigned by the stream at append. */
  timestamp: number;
  body: T;
}

export interface AppendOptions {
  /** Append only when the stream's tail equals this sequence. */
  matchSeq?: number;
}

export interface AppendAck {
  status: "ok";
  /** Sequence of the first appended record. */
  start: number;
  /** Sequence after the last appended record (the new tail). */
  end: number;
}

/** A conditional append found the stream elsewhere. Nothing was written. */
export interface SeqMismatch {
  status: "seq_mismatch";
  /** The stream's current tail. */
  tail: number;
}

export type AppendResult = AppendAck | SeqMismatch;

export interface ReadOptions {
  /** Ends the read. Iteration then finishes without throwing. */
  signal?: AbortSignal;
  /**
   * `true` (default) keeps reading live records after the history. `false`
   * stops at the tail observed when the read started (history requests).
   */
  follow?: boolean;
}

export interface DurableStreams {
  /**
   * Appends `records` as one batch. Rejects when the Tenant has no basin or
   * `records` is empty.
   */
  append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions,
  ): Promise<AppendResult>;
  /**
   * Reads `stream` from `fromSeq`: history first, then (with `follow`) live
   * records as they are appended, until `signal` aborts. Reading a stream that
   * does not exist yet waits for its first record.
   */
  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options?: ReadOptions,
  ): AsyncIterable<StreamRecord<T>>;
  /** The sequence the next record will get; 0 for a missing stream. */
  tail(tenantId: string, stream: string): Promise<number>;
  /** Creates the Tenant's basin. Idempotent. */
  ensureTenant(tenantId: string): Promise<void>;
  /** Deletes the Tenant's basin and all its streams. Idempotent. */
  deleteTenant(tenantId: string): Promise<void>;
  /** Deletes one stream (a deleted session). Idempotent. */
  deleteStream(tenantId: string, stream: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stream names and signal records

export const SESSION_STREAM_PREFIX = "sessions/";
/** `work_available` signals for executor connections. */
export const WORK_STREAM = "tenant/work";
/** `session.cancel` signals for owning Workers. */
export const CONTROL_STREAM = "tenant/control";

export function sessionStream(sessionId: string): string {
  if (!sessionId) throw new Error("sessionId is required");
  return `${SESSION_STREAM_PREFIX}${sessionId}`;
}

/** The session id of a `sessions/<id>` stream, or undefined for other streams. */
export function sessionIdOfStream(stream: string): string | undefined {
  return stream.startsWith(SESSION_STREAM_PREFIX) &&
    stream.length > SESSION_STREAM_PREFIX.length
    ? stream.slice(SESSION_STREAM_PREFIX.length)
    : undefined;
}

/**
 * Signals are not canonical events: they are appended without the outbox, and
 * a lost signal costs latency, not correctness.
 */
export interface WorkSignal {
  type: "work_available";
}

export interface ControlSignal {
  type: "session.cancel";
  sessionId: string;
}

export const WORK_AVAILABLE: Readonly<WorkSignal> = Object.freeze({
  type: "work_available",
});
