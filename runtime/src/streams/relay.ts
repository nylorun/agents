/**
 * The outbox relay (architecture §12.4, "Writing: outbox and relay").
 *
 * The Session Store writes every event to its outbox in the same transaction
 * as the state change. After the commit the relay appends the events to
 * `sessions/<sessionId>` with `matchSeq` set to the event's sequence, and
 * deletes the outbox rows S2 has:
 *
 * - **ok**: the rows are deleted through the last appended sequence.
 * - **`seq_mismatch` with the tail past the batch start**: an earlier attempt
 *   (this process or another) already appended those events. The rows below
 *   the tail are deleted, and whatever is left of the batch is appended from
 *   the tail.
 * - **`seq_mismatch` with the tail before the batch start**: earlier events of
 *   the session are still in the outbox (an earlier append failed). The
 *   session's outbox is drained in sequence order, which includes this batch.
 * - **append throws** (S2 unreachable): the rows stay in the outbox and the
 *   error goes to `onError`. The next commit of the session, or the Tenant
 *   sweep's `drain`, appends them in order.
 *
 * Conditional appends make this exactly-once and in order per session however
 * many processes relay the same rows. Within one process the relay also runs
 * one append at a time per session.
 *
 * `work_available` and `session.cancel` are signals, not canonical events: they
 * skip the outbox (`signalWork`, `signalCancel`). A commit that called
 * `t.signalWork()` is signalled by the relay after its events.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor } from "../store/cursor.js";
import type { Commit, OutboxRow, SessionStore } from "../store/types.js";
import {
  CONTROL_STREAM,
  WORK_AVAILABLE,
  WORK_STREAM,
  sessionStream,
  type ControlSignal,
  type DurableStreams,
} from "./types.js";

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
/** Outbox rows read per page while draining one session. */
const DRAIN_PAGE = 1000;

type Outcome = "done" | "gap";

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
   * Appends `rows` (one session, ascending, contiguous) with `matchSeq`, and
   * deletes what S2 has. Returns `gap` when the stream's tail is before the
   * first row still to append.
   */
  async function appendRows(sessionId: string, rows: readonly OutboxRow[]): Promise<Outcome> {
    let rest = rows;
    while (rest.length > 0) {
      const batch = takeBatch(rest);
      const first = batch[0]!.seq;
      const last = batch[batch.length - 1]!.seq;
      const result = await streams.append(
        tenantId,
        sessionStream(sessionId),
        batch.map((row) => row.event),
        { matchSeq: first },
      );
      if (result.status === "ok") {
        await store.tx((t) => t.deleteOutbox(sessionId, last));
        rest = rest.slice(batch.length);
      } else if (result.tail > first) {
        // Already appended by an earlier attempt: S2 has everything below the tail.
        await store.tx((t) => t.deleteOutbox(sessionId, result.tail - 1));
        rest = rest.filter((row) => row.seq >= result.tail);
      } else {
        return "gap";
      }
    }
    return "done";
  }

  /** Appends every outbox row of `sessionId` in sequence order. */
  async function drainSession(sessionId: string): Promise<number> {
    let relayed = 0;
    for (;;) {
      const rows = await store.tx((t) => t.outbox(DRAIN_PAGE, { sessionId }));
      if (rows.length === 0) return relayed;
      const run = contiguous(rows);
      if ((await appendRows(sessionId, run)) === "gap")
        throw new Error(
          `Outbox of session ${sessionId} starts at ${run[0]!.seq}, past the end of its stream; events before it are missing`,
        );
      relayed += run.length;
      if (rows.length < DRAIN_PAGE && run.length === rows.length) return relayed;
    }
  }

  async function relayCommitted(sessionId: string, rows: OutboxRow[]): Promise<void> {
    if ((await appendRows(sessionId, rows)) === "gap") await drainSession(sessionId);
  }

  function onCommit(commit: Commit): void {
    if (closed) return;
    const bySession = new Map<string, OutboxRow[]>();
    for (const event of commit.events) {
      const row = toRow(event);
      if (!row) {
        onError(new Error(`Event ${event.eventId} has an invalid cursor; left for the sweep`));
        continue;
      }
      let rows = bySession.get(row.sessionId);
      if (!rows) bySession.set(row.sessionId, (rows = []));
      rows.push(row);
    }
    const relays = [...bySession].map(([sessionId, rows]) => {
      rows.sort((a, b) => a.seq - b.seq);
      return serialize(sessionId, () => relayCommitted(sessionId, contiguous(rows))).catch(
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
      const bySession = new Map<string, OutboxRow[]>();
      for (const row of rows) {
        let list = bySession.get(row.sessionId);
        if (!list) bySession.set(row.sessionId, (list = []));
        list.push(row);
      }
      const counts = await Promise.all(
        [...bySession].map(([sessionId, list]) =>
          serialize(sessionId, async () => {
            list.sort((a, b) => a.seq - b.seq);
            // Rows may have been relayed since they were read; the conditional
            // appends in `appendRows` skip those.
            const run = contiguous(list);
            if ((await appendRows(sessionId, run)) === "gap")
              throw new Error(
                `Outbox of session ${sessionId} starts at ${run[0]!.seq}, past the end of its stream; events before it are missing`,
              );
            return run.length;
          }).catch((error: unknown) => {
            onError(error);
            return 0;
          }),
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

// ---------------------------------------------------------------------------

function toRow(event: LiveEvent): OutboxRow | undefined {
  try {
    return { sessionId: event.sessionId, seq: decodeCursor(event.sessionId, event.cursor), event };
  } catch {
    return undefined;
  }
}

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
