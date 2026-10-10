/**
 * The stream relay (Durable Streams §7): feeds S2 from the record, exactly once and in order
 * per session.
 *
 * - **Input.** Committed transactions from a `ChangeSource`, in commit order. The source
 *   keeps each one until it is acknowledged, so a crash replays what S2 may not have.
 * - **Pumps.** Each session has a queue and one pump. The pump appends the contiguous rows
 *   at the front of the queue as one batch to `sessions/<id>` in the row's basin generation,
 *   with `matchSeq` = the first row's `seq`:
 *   - `ok`: the rows are done;
 *   - tail past the batch: S2 already has those rows (a replay); they are done;
 *   - tail before the batch: S2 is missing rows (a lost stream, or rows the source never
 *     delivered); they are read from the record and put in front;
 *   - an error: the rows' generation is checked against the Tenant's (a reset or Tenant
 *     deletion makes them obsolete: done), the basin is ensured, and the batch is retried
 *     with backoff (50 ms to 2 s). The pump is per session, so order is kept.
 * - **Acknowledgement.** A transaction is acknowledged once all its rows are done, in commit
 *   order, never past one that is not.
 * - **Reconciliation.** When the source starts fresh (a new or lost slot), every session's S2
 *   tail is compared with its log head and the difference is re-sent from the record.
 *   `matchSeq` makes overlap with the live input harmless.
 *
 * The relay never writes the record and never deletes from S2.
 */
import { sleep } from "../../retry.js";
import { basinOf } from "../basin.js";
import { sessionStream, type DurableStreams } from "../types.js";
import type { ChangeSource, CommittedTx, LogHead, RecordReader, RecordRow } from "./types.js";

export interface StreamRelayOptions {
  source: ChangeSource;
  record: RecordReader;
  streams: DurableStreams;
  /** Relay events: lag, errors, reconciliations. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Records per append (S2 allows 1000). */
  maxBatchRecords?: number;
  /** Bytes per append (S2 allows 1 MiB). */
  maxBatchBytes?: number;
  /** Sessions reconciled at once. */
  reconcileConcurrency?: number;
}

export interface StreamRelayStatus {
  /** This process holds the source (the replication slot). */
  active: boolean;
  /** Committed transactions not yet fully in S2. */
  pendingTxs: number;
  /** Rows queued for S2. */
  pendingRows: number;
  /** The last position acknowledged to the source. */
  confirmed: string | null;
  reconciliations: number;
  lastError: string | null;
}

export interface StreamRelay {
  start(): void;
  stop(): Promise<void>;
  status(): StreamRelayStatus;
  /** Resolves once nothing is pending (tests and shutdown). */
  idle(): Promise<void>;
}

const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 2000;
const HEADS_PAGE = 500;

interface PendingTx {
  readonly endLsn: string | undefined;
  remaining: number;
}

interface QueuedRow extends RecordRow {
  readonly tx: PendingTx;
  readonly bytes: number;
}

interface SessionQueue {
  readonly tenantId: string;
  readonly sessionId: string;
  rows: QueuedRow[];
  running: boolean;
}

export function createStreamRelay(options: StreamRelayOptions): StreamRelay {
  const { source, record, streams } = options;
  const log = options.log ?? (() => {});
  const maxRecords = options.maxBatchRecords ?? 500;
  const maxBytes = options.maxBatchBytes ?? 768 * 1024;
  const concurrency = options.reconcileConcurrency ?? 8;

  /** Committed transactions not yet fully in S2, in commit order. */
  const txs: PendingTx[] = [];
  const sessions = new Map<string, SessionQueue>();
  let confirmed: string | null = null;
  let active = false;
  let stopped = false;
  let reconciliations = 0;
  let lastError: string | null = null;
  let idleWaiters: (() => void)[] = [];
  /** Woken when queued rows settle or the activation ends (`reconcile` waits on its rows). */
  let progressWaiters: (() => void)[] = [];
  /** Moves on with every activation and every loss of the source. */
  let activation = 0;
  const stopping = new AbortController();

  const keyOf = (tenantId: string, sessionId: string) => `${tenantId}\u0000${sessionId}`;

  function queueOf(tenantId: string, sessionId: string): SessionQueue {
    const key = keyOf(tenantId, sessionId);
    let queue = sessions.get(key);
    if (!queue) sessions.set(key, (queue = { tenantId, sessionId, rows: [], running: false }));
    return queue;
  }

  function queued(row: RecordRow, tx: PendingTx): QueuedRow {
    const body = JSON.stringify(row.body) ?? "null";
    return { ...row, seq: Number(row.seq), tx, bytes: Buffer.byteLength(body) };
  }

  function onTx(committed: CommittedTx): void {
    if (stopped) return;
    const tx: PendingTx = { endLsn: committed.endLsn, remaining: committed.rows.length };
    txs.push(tx);
    // Queue every row before pumping, so a transaction's rows go out in as few batches as fit.
    const touched = new Set<SessionQueue>();
    for (const row of committed.rows) {
      const queue = queueOf(row.tenantId, row.sessionId);
      queue.rows.push(queued(row, tx));
      touched.add(queue);
    }
    for (const queue of touched) pumpSoon(queue);
    advance();
  }

  function pumpSoon(queue: SessionQueue): void {
    if (!queue.running) void pump(queue);
  }

  function done(row: QueuedRow): void {
    row.tx.remaining -= 1;
  }

  /** The contiguous rows at the front of the queue, within the batch limits. */
  function takeBatch(rows: readonly QueuedRow[]): QueuedRow[] {
    const batch: QueuedRow[] = [rows[0]!];
    let bytes = rows[0]!.bytes;
    for (let i = 1; i < rows.length && batch.length < maxRecords; i += 1) {
      const row = rows[i]!;
      const previous = batch[batch.length - 1]!;
      if (row.seq !== previous.seq + 1 || row.generation !== previous.generation) break;
      if (bytes + row.bytes > maxBytes) break;
      bytes += row.bytes;
      batch.push(row);
    }
    return batch;
  }

  async function pump(queue: SessionQueue): Promise<void> {
    queue.running = true;
    let delay = RETRY_MIN_MS;
    try {
      while (queue.rows.length > 0 && !stopped) {
        // Duplicates (a replay overlapping a refill) and stale rows sort out here.
        queue.rows.sort((a, b) => a.generation - b.generation || a.seq - b.seq);
        const batch = takeBatch(queue.rows);
        const first = batch[0]!;
        const basin = basinOf(first.tenantId, first.generation);
        try {
          const result = await streams.append(
            basin,
            sessionStream(first.sessionId),
            batch.map((row) => row.body),
            { matchSeq: first.seq },
          );
          if (result.status === "ok") {
            settle(queue, (row) => batch.includes(row));
          } else if (result.tail > first.seq) {
            // A replay: S2 already has every row below its tail.
            settle(
              queue,
              (row) => row.generation === first.generation && row.seq < result.tail,
            );
          } else {
            // S2 is behind the record: re-send the gap first.
            await refill(queue, first.generation, result.tail, first.seq);
          }
          delay = RETRY_MIN_MS;
          lastError = null;
        } catch (error) {
          if (stopped) return;
          lastError = messageOf(error);
          if (await obsolete(first)) {
            settle(queue, (row) => row.generation <= first.generation);
            continue;
          }
          log("stream relay append failed; retrying", {
            tenantId: first.tenantId,
            sessionId: first.sessionId,
            seq: first.seq,
            retryInMs: delay,
            message: lastError,
          });
          // The basin may be missing (S2 lost it, or it was never created).
          await streams.ensureTenant(basin).catch(() => undefined);
          await sleep(delay, stopping.signal);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    } finally {
      queue.running = false;
      if (queue.rows.length === 0) sessions.delete(keyOf(queue.tenantId, queue.sessionId));
      else if (!stopped) pumpSoon(queue);
      advance();
    }
  }

  /** Marks the queue's rows matching `match` done and drops them. */
  function settle(queue: SessionQueue, match: (row: QueuedRow) => boolean): void {
    const keep: QueuedRow[] = [];
    for (const row of queue.rows) {
      if (match(row)) done(row);
      else keep.push(row);
    }
    queue.rows = keep;
    progressed();
  }

  function progressed(): void {
    const waiters = progressWaiters;
    progressWaiters = [];
    for (const wake of waiters) wake();
  }

  /** The rows' generation is no longer the Tenant's (a reset), or the Tenant is gone. */
  async function obsolete(row: RecordRow): Promise<boolean> {
    try {
      const current = await record.generation(row.tenantId);
      return current === undefined || current > row.generation;
    } catch {
      return false;
    }
  }

  /**
   * Puts record rows `[from, to)` in front of the queue (not part of the ack order). Returns
   * their pending count, which reaches 0 once they are all in S2.
   */
  async function refill(
    queue: SessionQueue,
    generation: number,
    from: number,
    to: number,
  ): Promise<PendingTx | undefined> {
    const rows = await record.readRange(queue.tenantId, queue.sessionId, from, to);
    const own = rows.filter((row) => row.generation === generation);
    if (own.length < to - from) {
      // The record no longer has them (a reset deleted the session): nothing to re-send.
      if (await obsolete({ ...queue, seq: from, generation, body: null })) {
        settle(queue, (row) => row.generation <= generation);
        return undefined;
      }
      throw new Error(
        `The record is missing rows ${from}..${to - 1} of session ${queue.sessionId}`,
      );
    }
    const tx: PendingTx = { endLsn: undefined, remaining: own.length };
    log("stream relay refilling a session from the record", {
      tenantId: queue.tenantId,
      sessionId: queue.sessionId,
      from,
      to,
    });
    queue.rows.unshift(...own.map((row) => queued(row, tx)));
    return tx;
  }

  /** Acknowledges the newest transaction whose rows, and all before it, are in S2. */
  function advance(): void {
    let lsn: string | undefined;
    while (txs.length > 0 && txs[0]!.remaining <= 0) lsn = txs.shift()!.endLsn ?? lsn;
    if (lsn) acknowledge(lsn);
    if (txs.length === 0 && sessions.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  function acknowledge(lsn: string): void {
    confirmed = lsn;
    source.acknowledge(lsn);
  }

  /**
   * Re-sends, for every session, what the record has beyond its S2 tail, and resolves true
   * once all of it is in S2. False when activation `of` ended first (the source was lost, so
   * the queued rows were dropped) or the relay stopped: the slot must stay unreconciled.
   */
  async function reconcile(of: number): Promise<boolean> {
    reconciliations += 1;
    const started = Date.now();
    const current = () => !stopped && activation === of;
    let sessionsChecked = 0;
    let resent = 0;
    const refilled: PendingTx[] = [];
    let after: { tenantId: string; sessionId: string } | undefined;
    for (;;) {
      if (!current()) return false;
      const page = await record.heads(after, HEADS_PAGE);
      if (page.length === 0) break;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, page.length) }, async () => {
          while (next < page.length && current()) {
            const head = page[next++]!;
            sessionsChecked += 1;
            const tx = await reconcileOne(head);
            if (tx) {
              refilled.push(tx);
              resent += tx.remaining;
            }
          }
        }),
      );
      const last = page[page.length - 1]!;
      after = { tenantId: last.tenantId, sessionId: last.sessionId };
    }
    // Queued is not delivered: wait until S2 has every re-sent row.
    while (current() && refilled.some((tx) => tx.remaining > 0))
      await new Promise<void>((resolve) => progressWaiters.push(resolve));
    if (!current()) return false;
    log("stream relay reconciled the record with S2", {
      sessions: sessionsChecked,
      resent,
      durationMs: Date.now() - started,
    });
    return true;
  }

  async function reconcileOne(head: LogHead): Promise<PendingTx | undefined> {
    const current = await record.generation(head.tenantId);
    if (current === undefined || current !== head.generation) return undefined;
    const basin = basinOf(head.tenantId, head.generation);
    await streams.ensureTenant(basin);
    const tail = await streams.tail(basin, sessionStream(head.sessionId));
    if (tail >= head.head) return undefined;
    const queue = queueOf(head.tenantId, head.sessionId);
    const tx = await refill(queue, head.generation, tail, head.head);
    pumpSoon(queue);
    return tx;
  }

  return {
    start() {
      source.start({
        onActive({ fresh }) {
          active = true;
          const of = (activation += 1);
          log("stream relay active", { fresh });
          if (fresh)
            void reconcile(of)
              .then((complete) => (complete ? source.reconciled() : undefined))
              .catch((error) => {
              lastError = messageOf(error);
              log("stream relay reconciliation failed", { message: lastError });
            });
        },
        onTx,
        onKeepalive(lsn) {
          // Caught up: let the source move past WAL that holds none of our rows.
          if (txs.length === 0) {
            confirmed = lsn;
            return lsn;
          }
          return undefined;
        },
        onInactive(error) {
          active = false;
          activation += 1;
          // The source replays everything not acknowledged; what is queued is dropped.
          txs.length = 0;
          for (const queue of sessions.values()) queue.rows = [];
          progressed();
          if (error) {
            lastError = messageOf(error);
            log("stream relay lost its source; retrying", { message: lastError });
          }
        },
      });
    },
    async stop() {
      stopped = true;
      stopping.abort();
      progressed();
      await source.stop();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake();
    },
    status: () => ({
      active,
      pendingTxs: txs.length,
      pendingRows: [...sessions.values()].reduce((n, queue) => n + queue.rows.length, 0),
      confirmed,
      reconciliations,
      lastError,
    }),
    idle() {
      if (txs.length === 0 && sessions.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
