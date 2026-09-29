/**
 * The outbox relay (architecture §12.4, "Writing: outbox and relay").
 *
 * The Session Store writes every event to its outbox in the same transaction
 * as the state change. After the commit the relay appends the events to the
 * stream of their session's incarnation (`sessions/<id>/<incarnation>`) with
 * `matchSeq` set to each batch's first sequence, and deletes the rows S2 has:
 *
 * - **The right incarnation.** A committed event comes with the incarnation
 *   its session had when the event was allocated (`Commit.incarnations`).
 *   Leftover rows (`drain`, and a commit that finds earlier rows still
 *   waiting) are read with the session's incarnation in one transaction that
 *   locks the session; deleting a session deletes its outbox rows in the same
 *   transaction, so those rows belong to the incarnation read. Either way a
 *   session deleted and created again with the same id never gets the old
 *   incarnation's events, or the reverse.
 * - **ok**: the rows are deleted through the last appended sequence, only
 *   while the session still has the incarnation appended to (one statement,
 *   `deleteOutbox` with `incarnation`).
 * - **`seq_mismatch` with the tail past the batch start**: an earlier attempt
 *   (this process or another) already appended those events. The rows below
 *   the tail are deleted, and whatever is left of the batch is appended from
 *   the tail.
 * - **`seq_mismatch` with the tail before the batch start**: earlier events of
 *   the session are still in the outbox (an earlier append failed), and the
 *   session's outbox is relayed in sequence order, which includes this batch.
 *   If the outbox's first row is past the tail, events are missing from the
 *   stream: the rows stay and the error goes to `onError`.
 * - **append throws** (S2 unreachable, basin missing): the rows stay in the
 *   outbox and the error goes to `onError`. The next commit of the session, or
 *   the Tenant sweep's `drain`, appends them in order.
 *
 * Conditional appends make this exactly-once and in order per session however
 * many processes relay the same rows. Within one process the relay also runs
 * one relay at a time per session.
 *
 * `work_available`, `session.cancel` and `sessions.reset` are signals, not
 * canonical events: they skip the outbox (`signalWork`, `signalCancel`,
 * `signalSessionsReset`). A commit that called `t.signalWork()` is signalled
 * by the relay after its events.
 */
import { decodeCursor } from "../store/cursor.js";
import type { Commit, OutboxRow, SessionStore } from "../store/types.js";
import {
  CONTROL_STREAM,
  WORK_AVAILABLE,
  WORK_STREAM,
  streamOfSession,
  type ControlSignal,
  type DurableStreams,
} from "./types.js";

/** A session's outbox starts past the end of its stream: events are missing from the stream. */
export class StreamGapError extends Error {
  constructor(sessionId: string, first: number, tail: number) {
    super(
      `Outbox of session ${sessionId} starts at ${first}, past the end of its stream at ${tail}; events before it are missing`,
    );
    this.name = "StreamGapError";
  }
}

export interface RelayOptions {
  store: SessionStore;
  streams: DurableStreams;
  /** The Tenant whose basin receives the events; must match `store.tenantId`. */
  tenantId: string;
  /** Receives append and delete failures. The rows they concern stay in the outbox. */
  onError?: (error: unknown) => void;
}

export interface Relay {
  /**
   * Appends leftover outbox rows (at most `limit`, default 1000) per session in
   * sequence order: the Tenant sweep's recovery after a crash or an S2 outage.
   * Resolves with the number of rows now in S2 and removed from the outbox.
   * Per-session failures go to `onError`; those rows stay.
   */
  drain(limit?: number): Promise<number>;
  /** Resolves when every relay started so far has settled. */
  idle(): Promise<void>;
  /** Stops listening to commits and waits for in-flight relays. */
  close(): Promise<void>;
}

/** At most this many records per append (S2 allows 1000). */
const MAX_BATCH_RECORDS = 500;
/** At most this many bytes of JSON per append (S2 allows 1 MiB metered). */
const MAX_BATCH_BYTES = 768 * 1024;
/** Outbox rows read per page while relaying one session. */
const DRAIN_PAGE = 1000;

export function createRelay(options: RelayOptions): Relay {
  const { store, streams, tenantId } = options;
  if (store.tenantId !== tenantId)
    throw new Error(`Relay tenant ${tenantId} does not match store tenant ${store.tenantId}`);
  const onError = options.onError ?? (() => {});
  /** sessionId → tail of that session's relay chain. */
  const chains = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;

  /** Runs `task` after every earlier task of the same session. */
  function serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(sessionId, settled);
    pending.add(settled);
    void settled.then(() => {
      pending.delete(settled);
      if (chains.get(sessionId) === settled) chains.delete(sessionId);
    });
    return run;
  }

  /**
   * Appends `rows` (one session, ascending, contiguous) to the stream of `incarnation`
   * with `matchSeq`, and deletes what S2 has while the session still has that incarnation.
   * Throws a `StreamGapError` when the stream's tail is before the first row still to append.
   */
  async function appendRows(
    sessionId: string,
    incarnation: string | null,
    rows: readonly OutboxRow[],
  ): Promise<void> {
    const stream = streamOfSession({
      id: sessionId,
      ...(incarnation === null ? {} : { streamIncarnation: incarnation }),
    });
    const deleteThrough = (seq: number) =>
      store.tx((t) => t.deleteOutbox(sessionId, seq, incarnation));
    let rest = rows;
    while (rest.length > 0) {
      const batch = takeBatch(rest);
      const first = batch[0]!.seq;
      const last = batch[batch.length - 1]!.seq;
      const result = await streams.append(
        tenantId,
        stream,
        batch.map((row) => row.event),
        { matchSeq: first },
      );
      if (result.status === "ok") {
        await deleteThrough(last);
        rest = rest.slice(batch.length);
      } else if (result.tail > first) {
        // Already appended by an earlier attempt: S2 has everything below the tail.
        await deleteThrough(result.tail - 1);
        rest = rest.filter((row) => row.seq >= result.tail);
      } else {
        throw new StreamGapError(sessionId, first, result.tail);
      }
    }
  }

  /**
   * Appends the session's outbox rows in sequence order, at most `limit`, reading them with
   * the session's incarnation under its lock. Resolves with the number relayed.
   */
  async function relaySession(sessionId: string, limit = Infinity): Promise<number> {
    let relayed = 0;
    while (relayed < limit) {
      const page = Math.min(DRAIN_PAGE, limit - relayed);
      const read = await store.tx(async (t) => {
        const session = await t.lockSession(sessionId);
        // A deleted session took its outbox rows with it.
        if (!session) return undefined;
        return {
          incarnation: session.streamIncarnation ?? null,
          rows: await t.outbox(page, { sessionId }),
        };
      });
      if (!read || read.rows.length === 0) return relayed;
      const run = contiguous(read.rows);
      await appendRows(sessionId, read.incarnation, run);
      relayed += run.length;
      // A gap inside the outbox: the next page starts at it and reports it.
      if (read.rows.length < page && run.length === read.rows.length) return relayed;
    }
    return relayed;
  }

  /**
   * Appends one commit's rows of a session to the stream of the incarnation they were
   * written under. When earlier rows are still in the outbox, relays the whole outbox.
   */
  async function relayCommitted(
    sessionId: string,
    incarnation: string | null,
    rows: OutboxRow[],
  ): Promise<void> {
    try {
      await appendRows(sessionId, incarnation, contiguous(rows));
    } catch (error) {
      if (!(error instanceof StreamGapError)) throw error;
      await relaySession(sessionId);
    }
  }

  function onCommit(commit: Commit): void {
    if (closed) return;
    /** `sessionId\0incarnation` → the commit's rows of that incarnation. */
    const groups = new Map<
      string,
      { sessionId: string; incarnation: string | null; rows: OutboxRow[] }
    >();
    commit.events.forEach((event, i) => {
      let seq: number;
      try {
        seq = decodeCursor(event.sessionId, event.cursor);
      } catch {
        onError(new Error(`Event ${event.eventId} has an invalid cursor; left for the sweep`));
        return;
      }
      const incarnation = commit.incarnations[i] ?? null;
      const key = `${event.sessionId}\u0000${incarnation ?? ""}`;
      let group = groups.get(key);
      if (!group)
        groups.set(key, (group = { sessionId: event.sessionId, incarnation, rows: [] }));
      group.rows.push({ sessionId: event.sessionId, seq, event });
    });
    const relays = [...groups.values()].map(({ sessionId, incarnation, rows }) => {
      rows.sort((a, b) => a.seq - b.seq);
      return serialize(sessionId, () => relayCommitted(sessionId, incarnation, rows)).catch(
        onError,
      );
    });
    if (commit.workAvailable) {
      const signalled = Promise.all(relays)
        .then(() => signalWork(streams, tenantId))
        .catch(onError);
      pending.add(signalled);
      void signalled.then(() => pending.delete(signalled));
    }
  }

  const unsubscribe = store.onCommit(onCommit);

  async function idle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return {
    async drain(limit = 1000) {
      const rows = await store.tx((t) => t.outbox(limit));
      const bySession = new Map<string, number>();
      for (const row of rows)
        bySession.set(row.sessionId, (bySession.get(row.sessionId) ?? 0) + 1);
      const counts = await Promise.all(
        [...bySession].map(([sessionId, count]) =>
          // Rows may have been relayed since they were read; the conditional
          // appends skip those.
          serialize(sessionId, () => relaySession(sessionId, count)).catch(
            (error: unknown) => {
              onError(error);
              return 0;
            },
          ),
        ),
      );
      return counts.reduce((sum, n) => sum + n, 0);
    },
    idle,
    async close() {
      closed = true;
      unsubscribe();
      await idle();
    },
  };
}

/** Appends a `work_available` signal to `tenant/work`. Not relayed through the outbox. */
export async function signalWork(streams: DurableStreams, tenantId: string): Promise<void> {
  await streams.append(tenantId, WORK_STREAM, [WORK_AVAILABLE]);
}

/** Appends a `session.cancel` signal to `tenant/control`. Not relayed through the outbox. */
export async function signalCancel(
  streams: DurableStreams,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  if (!sessionId) throw new Error("sessionId is required");
  const signal: ControlSignal = { type: "session.cancel", sessionId };
  await streams.append(tenantId, CONTROL_STREAM, [signal]);
}

/**
 * Appends a `sessions.reset` signal to `tenant/control`: every process with the Tenant open
 * checks its session feeds against the Session Store.
 */
export async function signalSessionsReset(
  streams: DurableStreams,
  tenantId: string,
): Promise<void> {
  const signal: ControlSignal = { type: "sessions.reset" };
  await streams.append(tenantId, CONTROL_STREAM, [signal]);
}

/**
 * Appends a `subject.revoked` signal to `tenant/control`: every process with the Tenant open
 * ends the subject's streams opened with a token older than `epoch`.
 */
export async function signalSubjectRevoked(
  streams: DurableStreams,
  tenantId: string,
  subject: string,
  epoch: number,
): Promise<void> {
  const signal: ControlSignal = { type: "subject.revoked", subject, epoch };
  await streams.append(tenantId, CONTROL_STREAM, [signal]);
}

// ---------------------------------------------------------------------------

/** The leading run of `rows` (ascending) without a sequence gap. */
function contiguous(rows: readonly OutboxRow[]): OutboxRow[] {
  let n = 1;
  while (n < rows.length && rows[n]!.seq === rows[n - 1]!.seq + 1) n += 1;
  return rows.slice(0, n);
}

/** The leading rows that fit one append. Always at least one row. */
function takeBatch(rows: readonly OutboxRow[]): readonly OutboxRow[] {
  let bytes = 0;
  let n = 0;
  while (n < rows.length && n < MAX_BATCH_RECORDS) {
    const size = JSON.stringify(rows[n]!.event).length + 8;
    if (n > 0 && bytes + size > MAX_BATCH_BYTES) break;
    bytes += size;
    n += 1;
  }
  return rows.slice(0, n);
}
