/**
 * Durable Streams on S2 (architecture §12.4). The only file that imports the
 * S2 SDK (`@s2-dev/streamstore`). Works against the S2 service and s2-lite,
 * which serve the same REST API.
 *
 * ## Layout
 *
 * - One basin per Tenant, named by `tenantBasinName` (`streams/basin.ts`):
 *   `<basinPrefix>tn-<ulid>` for a Tenant id `tn_<ulid>`.
 * - The basin is created with `createStreamOnAppend`, so `sessions/<id>/<incarnation>`,
 *   `tenant/work` and `tenant/control` come into existence on their first
 *   append. Its default stream config sets infinite retention, which session
 *   streams keep; the work and control streams are created with a one-day
 *   age-based retention instead (signals are latency hints, not history).
 * - Bodies are JSON text in string records. Record timestamps are S2 arrival
 *   times.
 * - Appends use `appendRetryPolicy: "noSideEffects"`: the SDK retries only
 *   failures that guarantee nothing was written, so an append is never
 *   duplicated here. A caller retrying an unacknowledged append passes
 *   `matchSeq` (as the relay does) and gets `seq_mismatch` if it had landed.
 *
 * ## s2-lite behaviour (architecture §19 question 3), verified on
 * `ghcr.io/s2-streamstore/s2:0.43.0` (`s2 lite`, in-memory) with SDK 0.27.0
 *
 * - **Retention.** The default stream config is `retentionPolicy: { ageSecs:
 *   604800 }` (7 days) and `storageClass: express`. Streams therefore need an
 *   explicit `{ infinite: {} }` retention to keep session history; this adapter
 *   sets it as the basin default, and s2-lite honours it (a new stream reports
 *   `infinite`). A `streamConfig` sent with an append that creates the stream
 *   is honoured too (used for the work and control streams). `deleteOnEmpty`
 *   defaults to disabled (`minAgeSecs: 0`).
 * - **Stream deletion** is immediate for our purposes: right after `DELETE`,
 *   `checkTail` and reads return 404 `stream_not_found` (new read sessions
 *   can briefly see 409 `stream_deletion_pending`), and an append re-creates
 *   the stream from sequence 0. Deleting a missing stream succeeds. Open read
 *   sessions see a command record, then fail with `stream_not_found`.
 * - **Basin deletion** is asynchronous: `DELETE` returns at once (also for a
 *   basin already being deleted), after which appends and `ensure` fail with
 *   409 `basin_deletion_pending` for about a minute (55 s measured) until the
 *   name is free again. Meanwhile the basin is listed with `deletedAt`, and
 *   its streams answer `stream_not_found`, so live reads check the basin when
 *   their stream is missing. `ensureTenant` waits the deletion out (up to
 *   `basinDeletionWaitMs`), so a Tenant reset that recreates the basin stalls
 *   for up to a minute on s2-lite.
 * - **Conditional appends.** `match_seq_num` equal to the tail appends;
 *   anything else fails with 412 (`SeqNumMismatchError`) carrying the tail as
 *   `expectedSeqNum`, and writes nothing. A retry of an acknowledged append
 *   with the same `match_seq_num` is rejected this way, never duplicated. On a
 *   missing stream a failed conditional append still creates the (empty)
 *   stream when `createStreamOnAppend` is on. Concurrent appends to one stream
 *   can fail with 409 `transaction_conflict` (nothing written); `append`
 *   retries those, and the conditional retry then resolves to ok or
 *   `seq_mismatch`.
 * - **Reads.** A read starting at or past the tail fails with 416
 *   (`RangeNotSatisfiableError`); with `clamp` a read session starts at the
 *   tail instead and follows it. Reading a missing stream is 404
 *   `stream_not_found`, a missing basin 404 `basin_not_found`. Read sessions
 *   use the SDK's HTTP/2 (s2s) transport, which s2-lite serves over cleartext.
 */
import {
  AppendInput,
  AppendRecord,
  RangeNotSatisfiableError,
  S2,
  S2Error,
  SeqNumMismatchError,
  type S2Stream,
} from "@s2-dev/streamstore";
import { tenantBasinName, validateBasinPrefix } from "../../streams/basin.js";
import {
  CONTROL_STREAM,
  WORK_STREAM,
  type AppendOptions,
  type AppendResult,
  type DurableStreams,
  type ReadOptions,
  type StreamRecord,
} from "../../streams/types.js";

export interface S2StreamsOptions {
  /**
   * Base URL serving both S2's account and basin APIs, e.g. `http://s2:80` for
   * s2-lite. Omit to use the S2 service's default endpoints.
   */
  endpoint?: string;
  /** Access token. s2-lite needs none. */
  token?: string;
  /** Prepended to every basin name (see `streams/basin.ts`). */
  basinPrefix?: string;
  /**
   * How long `ensureTenant` waits for a previous deletion of the same basin to
   * finish. Defaults to two minutes.
   */
  basinDeletionWaitMs?: number;
}

/** Retention of the work and control signal streams. */
const SIGNAL_RETENTION_SECS = 24 * 60 * 60;
/** Records per unary read while reading history. */
const HISTORY_PAGE = 1000;
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;
/** Attempts for an append that loses a `transaction_conflict` race. */
const CONFLICT_ATTEMPTS = 6;

export function createS2Streams(options: S2StreamsOptions = {}): DurableStreams {
  return new S2Streams(options);
}

class S2Streams implements DurableStreams {
  private readonly s2: S2;
  private readonly prefix: string;
  private readonly deletionWaitMs: number;
  /** Aborted by `close()`; ends every read and pending wait. */
  private readonly closing = new AbortController();

  constructor(options: S2StreamsOptions) {
    this.prefix = validateBasinPrefix(options.basinPrefix ?? "");
    this.deletionWaitMs = options.basinDeletionWaitMs ?? 120_000;
    this.s2 = new S2({
      accessToken: options.token ?? "s2-lite",
      ...(options.endpoint
        ? { endpoints: { account: options.endpoint, basin: options.endpoint } }
        : {}),
      retry: { appendRetryPolicy: "noSideEffects" },
    });
  }

  async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options: AppendOptions = {},
  ): Promise<AppendResult> {
    this.checkOpen();
    if (records.length === 0) throw new Error("append needs at least one record");
    const input = AppendInput.create(
      records.map((record) => {
        const body = JSON.stringify(record);
        if (body === undefined) throw new Error("Stream records must be JSON");
        return AppendRecord.string({ body });
      }),
      {
        ...(options.matchSeq !== undefined ? { matchSeqNum: options.matchSeq } : {}),
        ...(stream === WORK_STREAM || stream === CONTROL_STREAM
          ? { streamConfig: { retentionPolicy: { ageSecs: SIGNAL_RETENTION_SECS } } }
          : {}),
      },
    );
    const handle = this.handle(tenantId, stream);
    let delay = RETRY_MIN_MS / 4;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const ack = await handle.append(input, { signal: this.closing.signal });
        return { status: "ok", start: ack.start.seqNum, end: ack.end.seqNum };
      } catch (error) {
        if (error instanceof SeqNumMismatchError)
          return { status: "seq_mismatch", tail: error.expectedSeqNum };
        // Concurrent appends to one stream can abort each other; the aborted
        // one wrote nothing, so it is retried.
        if (!isTransactionConflict(error) || attempt >= CONFLICT_ATTEMPTS) throw error;
        await sleep(delay * (1 + Math.random()), this.closing.signal);
        this.checkOpen();
        delay *= 2;
      }
    }
  }

  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options: ReadOptions = {},
  ): AsyncIterable<StreamRecord<T>> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0)
      throw new Error("fromSeq must be a non-negative integer");
    return options.follow === false
      ? this.readHistory<T>(tenantId, stream, fromSeq, options.signal)
      : this.readLive<T>(tenantId, stream, fromSeq, options.signal);
  }

  async tail(tenantId: string, stream: string): Promise<number> {
    this.checkOpen();
    try {
      const { tail } = await this.handle(tenantId, stream).checkTail({
        signal: this.closing.signal,
      });
      return tail.seqNum;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async ensureTenant(tenantId: string): Promise<void> {
    this.checkOpen();
    const basin = this.basinName(tenantId);
    const deadline = Date.now() + this.deletionWaitMs;
    let delay = RETRY_MIN_MS * 5;
    for (;;) {
      try {
        await this.s2.basins.ensure(
          {
            basin,
            config: {
              createStreamOnAppend: true,
              defaultStreamConfig: { retentionPolicy: { infinite: {} } },
            },
          },
          { signal: this.closing.signal },
        );
        return;
      } catch (error) {
        if (!(error instanceof S2Error) || error.code !== "basin_deletion_pending")
          throw error;
        if (Date.now() + delay > deadline) throw error;
        await sleep(delay, this.closing.signal);
        this.checkOpen();
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  }

  async deleteTenant(tenantId: string): Promise<void> {
    this.checkOpen();
    try {
      await this.s2.basins.delete(
        { basin: this.basinName(tenantId) },
        { signal: this.closing.signal },
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async deleteStream(tenantId: string, stream: string): Promise<void> {
    this.checkOpen();
    try {
      await this.s2
        .basin(this.basinName(tenantId))
        .streams.delete({ stream }, { signal: this.closing.signal });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async listStreams(tenantId: string, prefix: string): Promise<string[]> {
    this.checkOpen();
    const names: string[] = [];
    try {
      for await (const info of this.s2
        .basin(this.basinName(tenantId))
        .streams.listAll({ prefix }, { signal: this.closing.signal }))
        if (info.deletedAt == null) names.push(info.name);
    } catch (error) {
      if (isMissing(error) || isTenantGone(error)) return [];
      throw error;
    }
    return names.sort();
  }

  async close(): Promise<void> {
    this.closing.abort();
  }

  /** Lists at most one basin: reachable, and the token (if any) is accepted. */
  async probe(signal: AbortSignal): Promise<void> {
    this.checkOpen();
    await this.s2.basins.list(
      { limit: 1 },
      { signal: anySignal(signal, this.closing.signal) },
    );
  }

  // -------------------------------------------------------------------------

  private async *readHistory<T>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamRecord<T>> {
    const aborted = anySignal(signal, this.closing.signal);
    const end = await this.tail(tenantId, stream);
    const handle = this.handle(tenantId, stream);
    let next = fromSeq;
    while (next < end && !aborted.aborted) {
      let records;
      try {
        ({ records } = await handle.read(
          {
            start: { from: { seqNum: next } },
            stop: { limits: { count: Math.min(HISTORY_PAGE, end - next) } },
            ignoreCommandRecords: true,
          },
          { signal: aborted },
        ));
      } catch (error) {
        // Trimmed, deleted or aborted under us: the history ends here.
        if (aborted.aborted || error instanceof RangeNotSatisfiableError || isMissing(error))
          return;
        throw error;
      }
      if (records.length === 0) return;
      for (const record of records) {
        if (record.seqNum >= end) return;
        if (record.seqNum < next) continue;
        next = record.seqNum + 1;
        yield toRecord<T>(record);
        if (aborted.aborted) return;
      }
    }
  }

  /**
   * Follows `stream` from `fromSeq` with S2 read sessions, reopening a session
   * from the next sequence whenever one ends or fails, until aborted, closed,
   * or the Tenant's basin is gone. A missing stream is polled until it exists.
   */
  private async *readLive<T>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamRecord<T>> {
    const aborted = anySignal(signal, this.closing.signal);
    const handle = this.handle(tenantId, stream);
    let next = fromSeq;
    let delay = RETRY_MIN_MS;
    try {
      while (!aborted.aborted) {
        try {
          const session = await handle.readSession(
            // `clamp` starts at the tail when `next` is past it; records before
            // `next` are then skipped below.
            { start: { from: { seqNum: next }, clamp: true }, ignoreCommandRecords: true },
            { signal: aborted },
          );
          for await (const record of session) {
            if (record.seqNum < next) continue;
            next = record.seqNum + 1;
            delay = RETRY_MIN_MS;
            yield toRecord<T>(record);
            if (aborted.aborted) return;
          }
        } catch (error) {
          if (aborted.aborted || isTenantGone(error)) return;
          // While a basin is being deleted its streams report
          // `stream_not_found`, so a missing stream also checks the basin.
          if (
            (isMissing(error) || isCode(error, "stream_deletion_pending")) &&
            (await this.basinGone(tenantId, aborted))
          )
            return;
          // Stream not created yet, or S2 unreachable: retry below.
        }
        await sleep(delay, aborted);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** True when the Tenant's basin does not exist or is being deleted. */
  private async basinGone(tenantId: string, signal: AbortSignal): Promise<boolean> {
    const basin = this.basinName(tenantId);
    try {
      const { basins } = await this.s2.basins.list({ prefix: basin, limit: 1 }, { signal });
      const info = basins.find((b) => b.name === basin);
      return !info || info.deletedAt != null;
    } catch {
      return false;
    }
  }

  private handle(tenantId: string, stream: string): S2Stream {
    return this.s2.basin(this.basinName(tenantId)).stream(stream);
  }

  private basinName(tenantId: string): string {
    return tenantBasinName(tenantId, this.prefix);
  }

  private checkOpen(): void {
    if (this.closing.signal.aborted) throw new Error("DurableStreams is closed");
  }
}

function toRecord<T>(record: { seqNum: number; timestamp: Date; body: string }): StreamRecord<T> {
  return {
    seq: record.seqNum,
    timestamp: record.timestamp.getTime(),
    body: JSON.parse(record.body) as T,
  };
}

/** A 404: the basin or the stream does not exist. */
function isMissing(error: unknown): boolean {
  return error instanceof S2Error && error.status === 404;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof S2Error && error.code === code;
}

/** 409 `transaction_conflict`: a concurrent append to the stream won; nothing was written. */
function isTransactionConflict(error: unknown): boolean {
  return isCode(error, "transaction_conflict");
}

/** The Tenant's basin is missing or being deleted: live reads end. */
function isTenantGone(error: unknown): boolean {
  return isCode(error, "basin_not_found") || isCode(error, "basin_deletion_pending");
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
