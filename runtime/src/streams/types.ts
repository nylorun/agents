/**
 * The Durable Streams seam (architecture §12.4).
 *
 * Durable Streams tell everyone else what the Session Store recorded. Each
 * Tenant has one S2 basin; inside it:
 *
 * | Stream | Contents | Written by | Read by |
 * | --- | --- | --- | --- |
 * | `sessions/<sessionId>/<incarnation>` | every `LiveEvent` of one incarnation of the session, in sequence | the relay, from the outbox | history and session SSE |
 * | `tenant/control` | `session.cancel` and `sessions.reset` signals | API nodes | every process with the Tenant open |
 *
 * **Incarnations.** A session's stream name carries an incarnation, a random
 * id stored on the session document when the session is created
 * (`streamIncarnation`, see `streamOfSession`). A session deleted by a reset
 * and created again with the same id gets a new incarnation, so a new stream
 * starting at sequence 0: nothing ever deletes and re-creates the same stream.
 * Abandoned streams are deleted best effort afterwards
 * (`collectSessionStreams` in `tenant/streams.ts`). The cursor stays
 * `base64url("<sessionId>:<seq>")`; readers resolve the incarnation from the
 * session.
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
 *   `SeqMismatch` carrying the current tail. The relay appends a session
 *   stream with `matchSeq` set to the outbox row's sequence, so a retried
 *   append after an unacknowledged success is detected and never duplicated.
 * - **Batches are atomic.** A batch is appended entirely or not at all.
 * - **Reads resume.** `read` from `fromSeq` yields every record with
 *   `seq >= fromSeq` in order, with no gap between history and the live tail.
 * - **Tenant scope.** `ensureTenant` creates the Tenant's basin (idempotent)
 *   and must run before appends; streams are created on first append.
 *   `deleteTenant` removes the basin and every stream in it.
 * - **Records are JSON.** Bodies are JSON-serializable values; implementations
 *   encode them as they need.
 */
import { randomBytes } from "node:crypto";

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
  /** Deletes one stream (an abandoned session incarnation). Idempotent. */
  deleteStream(tenantId: string, stream: string): Promise<void>;
  /**
   * Names of the Tenant's streams starting with `prefix`, in name order,
   * without streams being deleted. Empty when the Tenant has no basin.
   */
  listStreams(tenantId: string, prefix: string): Promise<string[]>;
  close(): Promise<void>;
  /**
   * Resolves when the backing service answers, rejects otherwise (readiness,
   * `infra/streams.ts`). Absent for in-process implementations, which are
   * always reachable.
   */
  probe?(signal: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stream names and signal records

export const SESSION_STREAM_PREFIX = "sessions/";
/** `session.cancel` and `sessions.reset` signals for every process with the Tenant open. */
export const CONTROL_STREAM = "tenant/control";

/**
 * The incarnation of a session document written before incarnations existed.
 * Random incarnations are 12 characters, so never this.
 */
export const LEGACY_INCARNATION = "0";

/** A new session incarnation: 12 random base64url characters. */
export function newStreamIncarnation(): string {
  return randomBytes(9).toString("base64url");
}

/** The stream of one incarnation of a session: `sessions/<sessionId>/<incarnation>`. */
export function sessionStream(sessionId: string, incarnation: string): string {
  if (!sessionId) throw new Error("sessionId is required");
  if (!incarnation || incarnation.includes("/"))
    throw new Error("incarnation must be non-empty and contain no '/'");
  return `${SESSION_STREAM_PREFIX}${sessionId}/${incarnation}`;
}

/** The fields of a session document that name its stream. */
export interface SessionStreamRef {
  id: string;
  /** Set when the session is created (`newStreamIncarnation`); never changed. */
  streamIncarnation?: string;
}

/** The stream of a session as stored now. */
export function streamOfSession(session: SessionStreamRef): string {
  return sessionStream(session.id, session.streamIncarnation ?? LEGACY_INCARNATION);
}

/** The session id and incarnation of a session stream, or undefined for other streams. */
export function parseSessionStream(
  stream: string,
): { sessionId: string; incarnation: string } | undefined {
  if (!stream.startsWith(SESSION_STREAM_PREFIX)) return undefined;
  const rest = stream.slice(SESSION_STREAM_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { sessionId: rest.slice(0, slash), incarnation: rest.slice(slash + 1) };
}

/**
 * Signals are not canonical events: they are appended without the outbox, and
 * a lost signal costs latency, not correctness.
 */
/** Ends the advance of `sessionId` on the process running it. */
export interface SessionCancelSignal {
  type: "session.cancel";
  sessionId: string;
}

/**
 * Session streams were abandoned (a Tenant reset): each process checks its
 * session feeds and ends those whose session is gone or has a new incarnation.
 */
export interface SessionsResetSignal {
  type: "sessions.reset";
}

/**
 * A subject's tokens older than `epoch` were revoked: each process ends that subject's
 * streams opened with them.
 */
export interface SubjectRevokedSignal {
  type: "subject.revoked";
  subject: string;
  epoch: number;
}

export type ControlSignal =
  | SessionCancelSignal
  | SessionsResetSignal
  | SubjectRevokedSignal;
