/**
 * The Durable Streams seam of an open Tenant (architecture §12.4), wired by one
 * `wireStreams(ctx, …)` call in the composition root:
 *
 * - **Basin.** The Tenant's basin is created when the Tenant is created (`createTenantStreams`)
 *   and checked when it opens. A missing basin (S2 down at creation, a crash in between) is
 *   repaired on first use: a failed `ensureTenant` or relay append retries `ensureTenant` in the
 *   background with backoff, and `streamsStatus` reports the basin's state. Only Tenant deletion
 *   deletes the basin (`deleteTenantStreams`); a reset never does (s2-lite keeps a deleted basin's
 *   name for about a minute).
 * - **Relay.** The outbox relay (`streams/relay.ts`) subscribes to the Session Store's commits,
 *   appends committed events to the session's stream, and appends `work_available` to
 *   `tenant/work` after a commit that called `t.signalWork()`. It is the only writer of either;
 *   business code never publishes or notifies.
 * - **Readers.** History and session SSE read the session's stream (`tenant/live.ts`). This
 *   module runs one `tenant/work` reader per Tenant per process, which wakes connected
 *   executors, and one `tenant/control` reader, which calls `ctx.abortLocal` for each
 *   `session.cancel` and checks the session feeds for each `sessions.reset`.
 * - **Incarnations.** A session's stream is `sessions/<id>/<incarnation>`, with the incarnation
 *   stored on the session when it is created (`streams/types.ts`). A reset abandons the
 *   streams of the sessions it deletes instead of deleting and re-creating them, so a session
 *   created again with the same id (during or after the reset, on any node) starts a new stream
 *   at sequence 0. Abandoned streams are deleted best effort by `collectSessionStreams`: right
 *   after the reset, and by the Tenant sweep until a collection succeeds. The pending
 *   collection is a Tenant setting written before the reset, so it survives a crash.
 * - **Recovery.** `drainOutbox(ctx)` appends leftover outbox rows (after a crash or an S2
 *   outage). The Tenant sweep calls it.
 *
 * The caller passes the streams: the Host's S2 streams, or `MemoryStreams` for tests and the
 * SQLite profile until Wave 4 (not durable).
 */
import { randomBytes } from "node:crypto";
import type { SessionStore } from "../store/types.js";
import {
  createRelay,
  signalCancel,
  signalSessionsReset,
  StreamGapError,
  type Relay,
} from "../streams/relay.js";
import {
  CONTROL_STREAM,
  SESSION_STREAM_PREFIX,
  WORK_STREAM,
  parseSessionStream,
  streamOfSession,
  type ControlSignal,
  type DurableStreams,
  type SessionStreamRef,
} from "../streams/types.js";
import type { TenantContext } from "./context.js";
import { announceWork, checkFeeds, sleep } from "./live.js";

export interface WireStreamsOptions {
  tenantId: string;
  store: SessionStore;
  streams: DurableStreams;
  /** Close `streams` with the wiring (streams created for this Tenant alone). */
  ownsStreams?: boolean;
  /** An existing relay to use instead of creating one; the caller closes it. */
  relay?: Relay;
}

/** The state of the Tenant's basin as this process last saw it. */
export interface BasinStatus {
  /** `ensureTenant` succeeded and no append has failed since. */
  ready: boolean;
  /** Failed `ensureTenant` attempts since the basin was last ready. */
  failures: number;
  /** The last failure's message, cleared once the basin is ready. */
  lastError: string | null;
}

/** What one `collectSessionStreams` pass did. */
export interface CollectResult {
  /** Abandoned session streams deleted. */
  deleted: number;
  /** Session streams of existing sessions, kept. */
  kept: number;
  /** Deletions that failed; the collection stays pending. */
  failed: number;
}

/** The handles `wireStreams` returns (also kept on `ctx.live.wiring`). */
export interface StreamsWiring {
  readonly streams: DurableStreams;
  readonly relay: Relay;
  /** The basin's state (`streamsStatus`). */
  basin(): BasinStatus;
  /** Appends leftover outbox rows, at most `limit`; resolves with the number relayed. */
  drain(limit?: number): Promise<number>;
  /**
   * Deletes abandoned session streams when a collection is pending; undefined when none was.
   * One pass at a time.
   */
  collect(): Promise<CollectResult | undefined>;
  /** Stops the readers, waits for in-flight relays, and closes what `wireStreams` created. */
  close(): Promise<void>;
}

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;
/** The longest wait between two `ensureTenant` attempts while the basin is being repaired. */
const BASIN_RETRY_MAX_MS = 5000;
/** A repair started within this long after the last one succeeded waits for the next failure. */
const BASIN_REPAIR_COOLDOWN_MS = 1000;
/** Outbox rows per drain page at open. */
const OPEN_DRAIN_PAGE = 1000;
/** How often every session feed is checked against its session (backstop for lost signals). */
const FEED_CHECK_MS = 30_000;
/** The Tenant setting that holds a pending collection's token ("" when none is pending). */
export const COLLECT_SETTING = "streams.collect";
/** Sessions looked up per transaction while collecting. */
const COLLECT_LOOKUP_PAGE = 500;
/** Stream deletions in flight at once while collecting. */
const COLLECT_PARALLEL = 8;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Wires the Tenant to Durable Streams: checks the basin, creates the relay (unless given),
 * starts the work and control readers, and records the handles on `ctx.live.wiring`. Call it
 * once, after `ctx` is built and before the Tenant serves requests.
 */
export async function wireStreams(
  ctx: TenantContext,
  options: WireStreamsOptions
): Promise<StreamsWiring> {
  if (ctx.live.wiring) throw new Error("Streams are already wired");
  const { store, streams, tenantId } = options;
  const logger = ctx.config.logger;
  const report = (what: string) => (error: unknown) =>
    logger.warn(what, { message: messageOf(error) });
  const stop = new AbortController();

  const basin = basinKeeper(streams, tenantId, stop.signal, report("stream basin unavailable; retrying"));
  // Wait for the first check so the first commits find the basin; a failure repairs it later.
  await basin.ensure().catch((error) => {
    report("stream basin unavailable; relaying later")(error);
    basin.repair();
  });

  const relay =
    options.relay ??
    createRelay({
      store,
      streams,
      tenantId,
      onError: (error) => {
        report("event relay failed; events stay in the outbox")(error);
        // The basin may be missing (never created, or deleted underneath); make sure of it.
        if (!(error instanceof StreamGapError)) basin.repair();
      },
    });

  const work = follow(
    streams,
    tenantId,
    WORK_STREAM,
    stop.signal,
    () => announceWork(ctx.live),
    report("work stream read failed; retrying")
  );
  const control = follow(
    streams,
    tenantId,
    CONTROL_STREAM,
    stop.signal,
    (body) => {
      const signal = body as Partial<ControlSignal> | null;
      if (signal?.type === "session.cancel" && typeof signal.sessionId === "string")
        ctx.abortLocal(signal.sessionId);
      else if (signal?.type === "sessions.reset")
        void checkFeeds(ctx).catch(report("session feed check failed"));
    },
    report("control stream read failed; retrying")
  );
  // Signals appended from here on reach this process.
  await Promise.all([work, control]);

  // Feeds whose session was reset end on the `sessions.reset` signal; this catches lost ones.
  const feedCheck = setInterval(
    () => void checkFeeds(ctx).catch(report("session feed check failed")),
    FEED_CHECK_MS
  );
  feedCheck.unref();

  let collecting: Promise<CollectResult | undefined> | undefined;
  const wiring: StreamsWiring = {
    streams,
    relay,
    basin: () => basin.status(),
    async drain(limit) {
      await basin.ensure();
      return relay.drain(limit);
    },
    collect() {
      collecting ??= collectSessionStreams(ctx, streams).finally(() => {
        collecting = undefined;
      });
      return collecting;
    },
    async close() {
      stop.abort();
      clearInterval(feedCheck);
      unregisterSweep();
      if (!options.relay) await relay.close();
      await collecting?.catch(() => undefined);
      if (options.ownsStreams) await streams.close();
    },
  };
  ctx.live.wiring = wiring;
  // The sweep retries a collection a reset left pending (or one a crash interrupted).
  const unregisterSweep = ctx.onSweep(async () => {
    await wiring.collect();
  });

  // Rows a previous process committed but did not relay; the sweep picks up what this misses.
  void (async () => {
    while ((await wiring.drain(OPEN_DRAIN_PAGE)) >= OPEN_DRAIN_PAGE);
  })().catch(report("outbox drain at open failed"));
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
      message: messageOf(error),
    })
  );
}

/**
 * Before a reset that deletes sessions: records a pending collection of their streams in the
 * Tenant settings, so it is retried by the sweep even if this process stops before it runs.
 */
export async function requestStreamCollection(ctx: TenantContext): Promise<void> {
  const token = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  await ctx.store.tx((t) => t.putSetting(COLLECT_SETTING, token));
}

/**
 * After a reset deleted sessions: tells every process with the Tenant open to check its
 * session feeds (`sessions.reset`), and deletes the abandoned streams now, best effort.
 * Failures are logged; the sweep retries the collection.
 */
export function sessionStreamsAbandoned(ctx: TenantContext): void {
  const wiring = ctx.live.wiring;
  if (!wiring) return;
  const warn = (what: string) => (error: unknown) =>
    ctx.config.logger.warn(what, { message: messageOf(error) });
  void signalSessionsReset(wiring.streams, ctx.config.tenantId).catch(
    warn("sessions.reset signal failed")
  );
  void wiring.collect().catch(warn("session stream collection failed; the sweep retries"));
}

/**
 * Deletes the Tenant's session streams that no session uses any more: streams of deleted
 * sessions and of earlier incarnations. Runs only while a collection is pending
 * (`requestStreamCollection`), and clears it once every deletion succeeded, unless another
 * reset requested a new one meanwhile.
 *
 * Streams are listed before their sessions are read, so a session created meanwhile keeps
 * its stream: its row committed before the relay created the stream.
 */
export async function collectSessionStreams(
  ctx: TenantContext,
  streams: DurableStreams
): Promise<CollectResult | undefined> {
  const { store } = ctx;
  const tenantId = ctx.config.tenantId;
  const token = await store.tx((t) => t.getSetting(COLLECT_SETTING));
  if (!token) return undefined;
  const bySession = new Map<string, string[]>();
  for (const name of await streams.listStreams(tenantId, SESSION_STREAM_PREFIX)) {
    const parsed = parseSessionStream(name);
    if (!parsed) continue;
    let names = bySession.get(parsed.sessionId);
    if (!names) bySession.set(parsed.sessionId, (names = []));
    names.push(name);
  }
  const ids = [...bySession.keys()];
  const current = new Map<string, string>();
  for (let i = 0; i < ids.length; i += COLLECT_LOOKUP_PAGE) {
    const page = ids.slice(i, i + COLLECT_LOOKUP_PAGE);
    await store.tx(async (t) => {
      for (const id of page) {
        const session = await t.get<SessionStreamRef>("sessions", id);
        if (session) current.set(id, streamOfSession(session));
      }
    });
  }
  const abandoned = [...bySession].flatMap(([id, names]) =>
    names.filter((name) => current.get(id) !== name)
  );
  const result: CollectResult = {
    deleted: 0,
    kept: [...bySession.values()].flat().length - abandoned.length,
    failed: 0,
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(COLLECT_PARALLEL, abandoned.length) }, async () => {
      while (next < abandoned.length) {
        const name = abandoned[next++]!;
        try {
          await streams.deleteStream(tenantId, name);
          result.deleted += 1;
        } catch (error) {
          result.failed += 1;
          ctx.config.logger.warn("session stream delete failed; the sweep retries", {
            stream: name,
            message: messageOf(error),
          });
        }
      }
    })
  );
  if (result.failed === 0)
    await store.tx(async (t) => {
      if ((await t.getSetting(COLLECT_SETTING)) === token)
        await t.putSetting(COLLECT_SETTING, "");
    });
  return result;
}

/** Tenant status of the streams seam (for `GET /v1/tenant` and the Admin API). */
export interface StreamsStatus {
  /** The streams' service answered a probe (`probeStreams`) within the timeout. */
  reachable: boolean;
  basin: BasinStatus;
  outbox: {
    /** Events committed but not yet in their streams. */
    depth: number;
    /** Age of the oldest of them, or null when the outbox is empty. */
    oldestAgeMs: number | null;
  };
  /** How far the relay is behind: the oldest unrelayed event's age, 0 when none is waiting. */
  relayLagMs: number;
  /** Abandoned session streams are waiting to be deleted. */
  collectionPending: boolean;
}

/**
 * The streams seam's status for an open Tenant: S2 reachability, the basin, outbox depth and
 * relay lag. Reads the Session Store and probes the streams (at most `probeTimeoutMs`).
 */
export async function streamsStatus(
  ctx: TenantContext,
  options: { probeTimeoutMs?: number; now?: () => number } = {}
): Promise<StreamsStatus> {
  const wiring = ctx.live.wiring;
  const now = options.now ?? Date.now;
  const [reachable, stored] = await Promise.all([
    wiring
      ? probe(wiring.streams, options.probeTimeoutMs ?? 2000)
      : Promise.resolve(false),
    ctx.store.tx(async (t) => ({
      outbox: await t.outboxStats(),
      collect: await t.getSetting(COLLECT_SETTING),
    })),
  ]);
  const oldest = stored.outbox.oldestCreatedAt;
  const oldestAgeMs =
    oldest === null ? null : Math.max(0, now() - Date.parse(oldest));
  return {
    reachable,
    basin: wiring?.basin() ?? { ready: false, failures: 0, lastError: null },
    outbox: { depth: stored.outbox.depth, oldestAgeMs },
    relayLagMs: oldestAgeMs ?? 0,
    collectionPending: !!stored.collect,
  };
}

/** Resolves true when the streams answer a probe within `timeoutMs` (in-process ones always do). */
async function probe(streams: DurableStreams, timeoutMs: number): Promise<boolean> {
  try {
    await streams.probe?.(AbortSignal.timeout(timeoutMs));
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a new Tenant's basin. Call it when the Tenant is created, after its schema commits;
 * retries transient failures, then throws. A failure need not fail the creation: opening the
 * Tenant repairs a missing basin.
 */
export async function createTenantStreams(
  streams: DurableStreams,
  tenantId: string,
  options: { attempts?: number } = {}
): Promise<void> {
  await withRetries(() => streams.ensureTenant(tenantId), options.attempts ?? 3);
}

/**
 * Deletes a Tenant's basin and every stream in it. Call it when the Tenant is deleted (never
 * on reset). Idempotent; retries transient failures, then throws.
 */
export async function deleteTenantStreams(
  streams: DurableStreams,
  tenantId: string,
  options: { attempts?: number } = {}
): Promise<void> {
  await withRetries(() => streams.deleteTenant(tenantId), options.attempts ?? 5);
}

/** Close: stops the readers and relay; the observers were ended by `endAllStreams`. */
export async function closeStreams(ctx: TenantContext): Promise<void> {
  await ctx.live.wiring?.close();
}

// ---------------------------------------------------------------------------

async function withRetries(task: () => Promise<void>, attempts: number): Promise<void> {
  let delay = RETRY_MIN_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }
}

interface BasinKeeper {
  /** Runs `ensureTenant` unless the basin is ready (one attempt at a time); rejects on failure. */
  ensure(): Promise<void>;
  /**
   * Re-checks the basin in the background, retrying with backoff until `ensureTenant`
   * succeeds. Called after failures; a no-op while a repair runs or just succeeded.
   */
  repair(): void;
  status(): BasinStatus;
}

function basinKeeper(
  streams: DurableStreams,
  tenantId: string,
  signal: AbortSignal,
  onError: (error: unknown) => void
): BasinKeeper {
  let ready = false;
  let failures = 0;
  let lastError: string | null = null;
  let attempt: Promise<void> | undefined;
  let repairing = false;
  let repairedAt = 0;

  const ensure = (): Promise<void> => {
    if (ready) return Promise.resolve();
    attempt ??= streams
      .ensureTenant(tenantId)
      .then(
        () => {
          ready = true;
          failures = 0;
          lastError = null;
        },
        (error: unknown) => {
          failures += 1;
          lastError = messageOf(error);
          throw error;
        }
      )
      .finally(() => {
        attempt = undefined;
      });
    return attempt;
  };

  return {
    ensure,
    repair() {
      if (repairing || signal.aborted) return;
      if (ready && Date.now() - repairedAt < BASIN_REPAIR_COOLDOWN_MS) return;
      repairing = true;
      ready = false;
      void (async () => {
        let delay = RETRY_MIN_MS;
        while (!signal.aborted) {
          try {
            await ensure();
            repairedAt = Date.now();
            break;
          } catch (error) {
            if (failures === 1 || failures % 10 === 0) onError(error);
          }
          await sleep(delay, signal);
          delay = Math.min(delay * 2, BASIN_RETRY_MAX_MS);
        }
        repairing = false;
      })();
    },
    status: () => ({ ready, failures, lastError }),
  };
}

/**
 * Follows a signal stream from its tail at start, calling `onRecord` for each record, until
 * `signal` aborts. Failed reads retry with backoff; a read that ends by itself (the basin was
 * deleted) starts again from the new tail. Resolves once the first tail is known (or failed).
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
