/**
 * The Durable Streams seam (Durable Streams §8).
 *
 * Durable Streams deliver what the record holds. Each Tenant has one S2 basin per basin
 * generation (`streams/basin.ts`); inside it:
 *
 * | Stream | Contents | Written by | Read by |
 * | --- | --- | --- | --- |
 * | `sessions/<sessionId>` | every event of the session, in sequence | the stream relay, from the record | history and session SSE |
 * | `tenant/control` | `session.cancel`, `sessions.reset` and `subject.revoked` signals | API nodes | every process with the Tenant open |
 *
 * **Basin generations.** A session id is unique within its Tenant's basin generation. A
 * Tenant reset, the only path that frees ids, moves the Tenant to the next generation, so
 * a session created again with the same id starts in an empty basin at sequence 0; the old
 * basin is deleted afterwards. The cursor is `base64url("<sessionId>:<seq>")`.
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
 *   stream with `matchSeq` set to the record row's sequence, so a retried
 *   append after an unacknowledged success is detected and never duplicated.
 * - **Batches are atomic.** A batch is appended entirely or not at all.
 * - **Reads resume.** `read` from `fromSeq` yields every record with
 *   `seq >= fromSeq` in order, with no gap between history and the live tail.
 * - **Tenant scope.** Methods take a Tenant id, or a basin key from `basinOf`
 *   for a later generation. `ensureTenant` creates the basin (idempotent) and
 *   must run before appends; streams are created on first append or read.
 *   `deleteTenant` removes the basin and every stream in it (with
 *   `allGenerations`, every generation's basin of the Tenant).
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
  /**
   * Deletes the basin and all its streams. Idempotent. With `allGenerations`, given a Tenant
   * id, also every later generation's basin (Tenant deletion).
   */
  deleteTenant(tenantId: string, options?: { allGenerations?: boolean }): Promise<void>;
  /** Deletes one stream. Idempotent. */
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

/** The stream of a session: `sessions/<sessionId>`. */
export function sessionStream(sessionId: string): string {
  if (!sessionId) throw new Error("sessionId is required");
  return `${SESSION_STREAM_PREFIX}${sessionId}`;
}

/**
 * Signals are not events: they are appended directly, never recorded, and a
 * lost signal costs latency, not correctness.
 */
/** Ends the advance of `sessionId` on the process running it. */
export interface SessionCancelSignal {
  type: "session.cancel";
  sessionId: string;
  /**
   * The cancelled turn. Only an advance of this turn stops, so a signal delivered late (an
   * append retried after S2 returns) never stops a later turn. Absent: any advance stops.
   */
  turnId?: string;
}

/**
 * The Tenant was reset and moved to basin generation `generation`. Appended to the old
 * generation's `tenant/control`: each process switches its readers to the new basin and
 * ends the streams of sessions the reset deleted.
 */
export interface SessionsResetSignal {
  type: "sessions.reset";
  generation?: number;
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

/**
 * An Action of `sessionId` has its outcome (F6.2): the process whose harness holds the
 * session's run while the Action is pending passes it on (`effect.resolved`).
 */
export interface ActionResolvedSignal {
  type: "action.resolved";
  sessionId: string;
  actionId: string;
}

export type ControlSignal =
  | SessionCancelSignal
  | SessionsResetSignal
  | SubjectRevokedSignal
  | ActionResolvedSignal;
