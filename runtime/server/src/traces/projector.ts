/**
 * The trace projector (R7.2, Q1): a second reader of the session log, beside the stream relay. It
 * reads committed `session_events` from its own replication slot (`nylorun_trace_export`, on the
 * relay's publication), maps each row to at most one span (`map.ts`), and posts them as OTLP to the
 * operator's collector. It holds no state that changes a span, so a replay of its slot posts the
 * same spans with the same ids. It never reads S2 (D48), and no turn waits for it.
 *
 * - **One process at a time.** The slot is the leader election, as for the relay: every process
 *   running core runs a projector, and one reads.
 * - **Batches** of up to 512 spans, or what came within 2 s, posted one at a time
 *   (`otlp.ts`: retried, then dropped and logged).
 * - **Acknowledged in commit order** once a transaction's spans are posted or dropped, so a dead
 *   collector makes Postgres keep no WAL. A transaction with no span is acknowledged with the
 *   rest. While the collector is slow, more than `maxQueuedSpans` waiting are dropped.
 * - **Turns.** A bounded cache keeps each turn's trace (`turnTraceOf`) from its `command.message`;
 *   a turn not in it (after a restart mid turn, or one evicted) reads its `command.message` once.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ChangeSource, CommittedTx } from "../streams/relay/types.js";
import type { TraceKey } from "./ids.js";
import { spanOf, turnTraceOf, type OtlpSpan, type SpanSettings, type TraceContent, type TurnTrace } from "./map.js";
import type { OtlpPoster } from "./otlp.js";
import { hostTuning } from "../tuning.js";

/** The projector's replication slot. */
export const TRACE_SLOT = "nylorun_trace_export";

export interface TraceProjectorOptions {
  readonly source: ChangeSource;
  readonly post: OtlpPoster;
  /** The Tenant's trace key (`traces/key.ts`). */
  readonly key: () => Promise<TraceKey>;
  /** The Tenant's Runtime limit `traceContentBytes`, read for each transaction mapped. */
  readonly contentBytes: () => Promise<number>;
  /** The `command.message` that started turn `turnId`, or undefined when the log has none. */
  readonly turnMessage: (sessionId: string, turnId: string) => Promise<LiveEvent | undefined>;
  readonly content: TraceContent;
  /** Spans per post. Default `traces.batchSpans` (Host tuning, 512). */
  readonly maxBatch?: number;
  /** How long a span waits for its batch to fill. Default `traces.batchDelayMs` (2 s). */
  readonly maxDelayMs?: number;
  /**
   * Spans waiting while a post is out, past which the waiting ones are dropped. Default
   * `traces.queuedSpansMax` (8192).
   */
  readonly maxQueuedSpans?: number;
  /** Turns whose trace is kept. Default `traces.turnCacheSize` (1024). */
  readonly turnCacheSize?: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface TraceProjector {
  start(): void;
  stop(): Promise<void>;
  /** This process reads the slot, and what it has not acknowledged. */
  status(): { active: boolean; pendingTxs: number; pendingSpans: number; confirmed: string | null };
  /** Resolves once everything received is posted or dropped and acknowledged (tests, shutdown). */
  idle(): Promise<void>;
  /** How far the slot is behind, in bytes, when known. */
  lag(): Promise<number | undefined>;
}

interface PendingTx {
  readonly endLsn: string;
  spans: OtlpSpan[];
}

export function createTraceProjector(options: TraceProjectorOptions): TraceProjector {
  const { source, post } = options;
  const log = options.log ?? (() => {});
  const tuning = hostTuning().traces;
  const maxBatch = options.maxBatch ?? tuning.batchSpans;
  const maxDelayMs = options.maxDelayMs ?? tuning.batchDelayMs;
  const maxQueued = options.maxQueuedSpans ?? tuning.queuedSpansMax;
  const cacheSize = options.turnCacheSize ?? tuning.turnCacheSize;
  const turns = new Map<string, TurnTrace>();
  const stopping = new AbortController();

  /** Mapped transactions not yet posted, in commit order. */
  let waiting: PendingTx[] = [];
  let waitingSpans = 0;
  /** Received transactions still being mapped, in commit order. */
  let mapping: Promise<void> = Promise.resolve();
  let mappingCount = 0;
  let posting: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let confirmed: string | null = null;
  /** Moves on with every loss of the source: work of an earlier activation is discarded. */
  let activation = 0;
  let idleWaiters: (() => void)[] = [];

  function remember(key: string, trace: TurnTrace): TurnTrace {
    turns.delete(key);
    turns.set(key, trace);
    if (turns.size > cacheSize) turns.delete(turns.keys().next().value!);
    return trace;
  }

  async function turnOf(
    row: LiveEvent,
    settings: SpanSettings,
  ): Promise<TurnTrace> {
    const turnId = row.turnId!;
    const cacheKey = `${row.sessionId}\u0000${turnId}`;
    const ids = { tenantId: row.tenantId, sessionId: row.sessionId, turnId };
    if (row.type === "command.message") return remember(cacheKey, turnTraceOf(settings, ids, row));
    const known = turns.get(cacheKey);
    if (known) return remember(cacheKey, known);
    return remember(cacheKey, turnTraceOf(settings, ids, await options.turnMessage(row.sessionId, turnId)));
  }

  async function spansOf(tx: CommittedTx): Promise<OtlpSpan[]> {
    const spans: OtlpSpan[] = [];
    if (tx.rows.length === 0) return spans;
    const settings = { key: await options.key(), content: options.content, contentBytes: await options.contentBytes() };
    for (const record of tx.rows) {
      const row = record.body as LiveEvent;
      if (!row || typeof row !== "object" || row.turnId == null) continue;
      const span = spanOf(row, await turnOf(row, settings), settings);
      if (span) spans.push(span);
    }
    return spans;
  }

  function onTx(tx: CommittedTx): void {
    const of = activation;
    mappingCount += 1;
    mapping = mapping.then(async () => {
      try {
        let spans: OtlpSpan[];
        for (;;) {
          try {
            spans = await spansOf(tx);
            break;
          } catch (error) {
            // The key or a turn's message could not be read (Postgres away): try again, in order.
            if (of !== activation || stopping.signal.aborted) return;
            log("trace_projector_retry", { message: error instanceof Error ? error.message : String(error) });
            await new Promise((resolve) => setTimeout(resolve, tuning.retryMs));
          }
        }
        if (of !== activation) return;
        waiting.push({ endLsn: tx.endLsn, spans });
        waitingSpans += spans.length;
        if (posting && waitingSpans > maxQueued) {
          // The collector is slower than the log: drop what waits, keep its place to acknowledge.
          log("trace_export_dropped", { spans: waitingSpans, reason: "queue full" });
          for (const pending of waiting) pending.spans = [];
          waitingSpans = 0;
        }
        schedule();
      } finally {
        mappingCount -= 1;
        settle();
      }
    });
  }

  function schedule(): void {
    if (posting || waiting.length === 0) return;
    // Nothing to post: acknowledge at once.
    if (waitingSpans === 0 || waitingSpans >= maxBatch || stopping.signal.aborted) return void flush();
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
    }, maxDelayMs);
  }

  function flush(): void {
    if (posting || waiting.length === 0) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const of = activation;
    const batch = waiting;
    waiting = [];
    waitingSpans = 0;
    posting = (async () => {
      const spans = batch.flatMap((tx) => tx.spans);
      // A post a shutdown cut short is not the collector's failure: those rows go again.
      let cut = false;
      for (let at = 0; at < spans.length; at += maxBatch)
        if ((await post(spans.slice(at, at + maxBatch), stopping.signal)) === "dropped" && stopping.signal.aborted)
          cut = true;
      // Posted or dropped: the rows are done. A source lost meanwhile replays them anyway.
      if (of === activation && !cut) {
        confirmed = batch.at(-1)!.endLsn;
        source.acknowledge(confirmed);
      }
    })().finally(() => {
      posting = undefined;
      schedule();
      settle();
    });
  }

  function settle(): void {
    if (posting || mappingCount > 0 || waiting.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  return {
    start() {
      source.start({
        onActive({ fresh }) {
          active = true;
          log("trace projector active", { fresh });
          // A fresh slot has nothing to reconcile: it exports from now on.
          if (fresh) void source.reconciled().catch(() => undefined);
        },
        onTx,
        onKeepalive(lsn) {
          // Caught up: let the slot move past WAL that holds none of our rows.
          if (posting || mappingCount > 0 || waiting.length > 0) return undefined;
          confirmed = lsn;
          return lsn;
        },
        onInactive(error) {
          active = false;
          activation += 1;
          // The slot replays everything not acknowledged; what waits is dropped.
          waiting = [];
          waitingSpans = 0;
          if (timer) clearTimeout(timer);
          timer = undefined;
          settle();
          if (error)
            log("trace projector lost its source; retrying", {
              message: error instanceof Error ? error.message : String(error),
            });
        },
      });
    },
    async stop() {
      // Post what is mapped (each post gives up at once), then stop reading.
      stopping.abort();
      await mapping.catch(() => undefined);
      flush();
      await posting?.catch(() => undefined);
      await source.stop();
    },
    status: () => ({
      active,
      pendingTxs: waiting.length + mappingCount,
      pendingSpans: waitingSpans,
      confirmed,
    }),
    idle() {
      if (!posting && mappingCount === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    lag: async () => (await source.lag?.()) ?? undefined,
  };
}
