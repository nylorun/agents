/**
 * The Durable Streams seam of an open Tenant (architecture §12.4), wired by one
 * `wireStreams(ctx, …)` call in the composition root:
 *
 * - **Relay.** The outbox relay (`streams/relay.ts`) subscribes to the Session Store's commits,
 *   appends committed events to `sessions/<id>`, and appends `work_available` to
 *   `tenant/work` after a commit that called `t.signalWork()`. It is the only writer of
 *   either; business code never publishes or notifies.
 * - **Readers.** History and session SSE read `sessions/<id>` (`tenant/live.ts`). This module
 *   runs one `tenant/work` reader per Tenant per process, which wakes connected executors, and
 *   one `tenant/control` reader, which calls `ctx.abortLocal` for each `session.cancel`.
 * - **Recovery.** `drainOutbox(ctx)` appends leftover outbox rows (after a crash or an S2
 *   outage). The Tenant sweep calls it.
 *
 * Until Wave 3 wires S2, a Tenant opened without `streams` gets in-memory streams re-hydrated
 * from the SQLite `events` table (`interimSqliteStreams`).
 */
import type { SessionStore } from "../store/types.js";
import type { SqliteSessionStore } from "../store/sqlite.js";
import { MemoryStreams } from "../streams/memory.js";
import { createRelay, signalCancel, type Relay } from "../streams/relay.js";
import {
  CONTROL_STREAM,
  WORK_STREAM,
  sessionStream,
  type ControlSignal,
  type DurableStreams,
} from "../streams/types.js";
import type { TenantContext } from "./context.js";
import { announceWork, sleep } from "./live.js";

export type WireStreamsOptions = {
  tenantId: string;
  /** An existing relay to use instead of creating one; the caller closes it. */
  relay?: Relay;
} & (
  | { store: SessionStore; streams: DurableStreams }
  | {
      /** Without `streams`, the interim in-memory streams re-hydrate from this SQLite store. */
      store: SqliteSessionStore;
      streams?: undefined;
    }
);

/** The handles `wireStreams` returns (also kept on `ctx.live.wiring`). */
export interface StreamsWiring {
  readonly streams: DurableStreams;
  readonly relay: Relay;
  /** Appends leftover outbox rows, at most `limit`; resolves with the number relayed. */
  drain(limit?: number): Promise<number>;
  /** Stops the readers, waits for in-flight relays, and closes what `wireStreams` created. */
  close(): Promise<void>;
}

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;
/** Outbox rows per drain page at open. */
const OPEN_DRAIN_PAGE = 1000;

/**
 * Wires the Tenant to Durable Streams: creates the relay (unless given), starts the work and
 * control readers, and records the handles on `ctx.live.wiring`. Call it once, after `ctx` is
 * built and before the Tenant serves requests.
 */
export async function wireStreams(
  ctx: TenantContext,
  options: WireStreamsOptions
): Promise<StreamsWiring> {
  if (ctx.live.wiring) throw new Error("Streams are already wired");
  const { store, tenantId } = options;
  const logger = ctx.config.logger;
  const report = (what: string) => (error: unknown) =>
    logger.warn(what, {
      message: error instanceof Error ? error.message : String(error),
    });

  const owned = options.streams === undefined;
  const streams = owned
    ? await interimSqliteStreams(options.store as SqliteSessionStore, tenantId)
    : options.streams!;

  let ensured = false;
  const ensure = async () => {
    if (ensured) return;
    await streams.ensureTenant(tenantId);
    ensured = true;
  };
  await ensure().catch(report("stream basin unavailable; relaying later"));

  const relay =
    options.relay ??
    createRelay({
      store,
      streams,
      tenantId,
      onError: report("event relay failed; events stay in the outbox"),
    });

  const readers = new AbortController();
  const work = follow(
    streams,
    tenantId,
    WORK_STREAM,
    readers.signal,
    () => announceWork(ctx.live),
    report("work stream read failed; retrying")
  );
  const control = follow(
    streams,
    tenantId,
    CONTROL_STREAM,
    readers.signal,
    (body) => {
      const signal = body as Partial<ControlSignal> | null;
      if (signal?.type === "session.cancel" && typeof signal.sessionId === "string")
        ctx.abortLocal(signal.sessionId);
    },
    report("control stream read failed; retrying")
  );
  // Signals appended from here on reach this process.
  await Promise.all([work, control]);

  const wiring: StreamsWiring = {
    streams,
    relay,
    async drain(limit) {
      await ensure();
      return relay.drain(limit);
    },
    async close() {
      readers.abort();
      if (!options.relay) await relay.close();
      if (owned) await streams.close();
    },
  };
  ctx.live.wiring = wiring;

  // Rows a previous process committed but did not relay. With the interim streams, history
  // is incomplete until they are in, so wait; otherwise the sweep picks up what this misses.
  const drainAll = async () => {
    while ((await wiring.drain(OPEN_DRAIN_PAGE)) >= OPEN_DRAIN_PAGE);
  };
  if (owned) await drainAll().catch(report("outbox drain at open failed"));
  else void drainAll().catch(report("outbox drain at open failed"));
  return wiring;
}

/** The Tenant sweep's outbox recovery: appends leftover rows, at most `limit`. */
export function drainOutbox(ctx: TenantContext, limit?: number): Promise<number> {
  const wiring = ctx.live.wiring;
  return wiring ? wiring.drain(limit) : Promise.resolve(0);
}

/**
 * Appends `session.cancel` for `sessionId` to `tenant/control`, so the process running its
 * advance aborts it. Call it from `t.afterCommit` after a cancel commits. A lost signal costs
 * latency only (the advance checks the Session Store before every effect), so failures are
 * logged, never thrown.
 */
export function signalSessionCancel(ctx: TenantContext, sessionId: string): void {
  const streams = ctx.live.wiring?.streams;
  if (!streams) return;
  void signalCancel(streams, ctx.config.tenantId, sessionId).catch((error) =>
    ctx.config.logger.warn("cancel signal failed", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  );
}

/**
 * Deletes the streams of sessions a reset removed, so a session re-created with the same id
 * starts again at sequence 0. Failures are logged.
 */
export async function deleteSessionStreams(
  ctx: TenantContext,
  sessionIds: readonly string[]
): Promise<void> {
  const streams = ctx.live.wiring?.streams;
  if (!streams) return;
  await Promise.all(
    sessionIds.map((id) =>
      streams
        .deleteStream(ctx.config.tenantId, sessionStream(id))
        .catch((error) =>
          ctx.config.logger.warn("session stream delete failed", {
            sessionId: id,
            message: error instanceof Error ? error.message : String(error),
          })
        )
    )
  );
}

/** Close: stops the readers and relay; the observers were ended by `endAllStreams`. */
export async function closeStreams(ctx: TenantContext): Promise<void> {
  await ctx.live.wiring?.close();
}

/**
 * Follows a signal stream from its tail at start, calling `onRecord` for each record, until
 * `signal` aborts. Failed reads retry with backoff; a read that ends by itself (the basin was
 * reset) starts again from the new tail. Resolves once the first tail is known (or failed).
 */
function follow(
  streams: DurableStreams,
  tenantId: string,
  stream: string,
  signal: AbortSignal,
  onRecord: (body: unknown) => void,
  onError: (error: unknown) => void
): Promise<void> {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  void (async () => {
    let from: number | undefined;
    let delay = RETRY_MIN_MS;
    while (!signal.aborted) {
      try {
        try {
          from ??= await streams.tail(tenantId, stream);
        } finally {
          started();
        }
        for await (const record of streams.read(tenantId, stream, from, {
          signal,
        })) {
          from = record.seq + 1;
          delay = RETRY_MIN_MS;
          try {
            onRecord(record.body);
          } catch (error) {
            onError(error);
          }
        }
        if (signal.aborted) return;
        from = undefined;
      } catch (error) {
        if (signal.aborted) return;
        onError(error);
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
    started();
  })();
  return ready;
}

/**
 * Interim durability for the SQLite profile. Wave 3 removes this function.
 *
 * The SQLite profile has no real Durable Streams yet, so a Tenant opened without `streams`
 * gets in-memory streams, re-hydrated here from the `events` table: every relayed row, in
 * sequence order per session, becomes that session's stream again, so history survives
 * restarts. Unrelayed rows (the outbox) are left for the relay's drain at open.
 */
async function interimSqliteStreams(
  store: SqliteSessionStore,
  tenantId: string
): Promise<DurableStreams> {
  if (typeof store.readRelayed !== "function")
    throw new Error("wireStreams needs streams or a SQLite store to re-hydrate from");
  const streams = new MemoryStreams();
  await streams.ensureTenant(tenantId);
  const rows = await store.readRelayed();
  let start = 0;
  while (start < rows.length) {
    const sessionId = rows[start]!.sessionId;
    let end = start;
    while (end < rows.length && rows[end]!.sessionId === sessionId) end += 1;
    const events = rows.slice(start, end);
    if (events.some((row, i) => row.seq !== i))
      throw new Error(`Relayed events of session ${sessionId} have a sequence gap`);
    await streams.append(
      tenantId,
      sessionStream(sessionId),
      events.map((row) => row.event),
      { matchSeq: 0 }
    );
    start = end;
  }
  return streams;
}
