/**
 * The Durable Streams seam of an open Tenant (Durable Streams §7–§9), wired by one
 * `wireStreams(ctx, …)` call in the composition root:
 *
 * - **Record.** Every event is written to the record in its transaction (`Tx.event`). The
 *   stream relay (`streams/relay/`) feeds the Tenant's basin from it. On a Host with S2, one
 *   process-wide relay reads the record over logical replication (`host/main.ts`);
 *   otherwise (tests, a Host without S2) this module runs a relay of the Tenant's own commits,
 *   which reconciles the record with the streams when it starts.
 * - **Basin generations.** The Tenant's session streams live in its current basin generation
 *   (`streams/basin.ts`). A reset moves it to the next one (`tenantReset`): the old basin gets
 *   a `sessions.reset` signal, every process moves its readers, and the old basin is deleted
 *   after a grace period (again when the Tenant opens, until it is gone).
 * - **Basin.** The current basin is created when the Tenant opens. A missing basin (S2 down
 *   then, or deleted since) is repaired on first use: a failed `ensureTenant` retries in the background with backoff,
 *   and `streamsStatus` reports the basin's state.
 * - **Readers.** History and session SSE read the session's stream
 *   (`tenant/session-streams.ts`). This module runs one `tenant/control` reader per Tenant per
 *   process, on the current basin, which calls `ctx.abortLocal` for each `session.cancel`,
 *   passes an Action's outcome to a run held here for each `action.resolved` (F6.2), and
 *   checks the session streams for each `sessions.reset`.
 *
 * The caller passes the streams: the Host's S2 streams, or `MemoryStreams` for tests and a
 * local development Host (not durable).
 */
import type { Commit, SessionStore } from "../store/types.js";
import { basinOf } from "../streams/basin.js";
import { signalActionResolved, signalCancel, signalSessionsReset } from "../streams/control.js";
import {
  createStreamRelay,
  type StreamRelay,
  type StreamRelayStatus,
} from "../streams/relay/core.js";
import type { ChangeHandlers, ChangeSource } from "../streams/relay/types.js";
import {
  CONTROL_STREAM,
  type ControlSignal,
  type DurableStreams,
} from "../streams/types.js";
import type { TenantContext } from "./context.js";
import {
  checkSessionStreams,
  currentBasin,
  sleep,
} from "./session-streams.js";

export interface WireStreamsOptions {
  tenantId: string;
  store: SessionStore;
  streams: DurableStreams;
  /** Close `streams` with the wiring (streams created for this Tenant alone). */
  ownsStreams?: boolean;
  /**
   * The Host runs the stream relay for the Tenant (logical replication). Otherwise the
   * Tenant relays its own commits.
   */
  hostRelay?: boolean;
  /** How long a retired basin is kept for readers still on it. Default 60 s. */
  retireGraceMs?: number;
}

/** The state of the Tenant's current basin as this process last saw it. */
export interface BasinStatus {
  /** `ensureTenant` succeeded and no append has failed since. */
  ready: boolean;
  /** Failed `ensureTenant` attempts since the basin was last ready. */
  failures: number;
  /** The last failure's message, cleared once the basin is ready. */
  lastError: string | null;
}

/** The handles `wireStreams` returns (also kept on `ctx.sessionStreams.wiring`). */
export interface StreamsWiring {
  readonly streams: DurableStreams;
  /** The Tenant's own relay; undefined when the Host relays. */
  readonly relay: StreamRelay | undefined;
  /** The current basin's state (`streamsStatus`). */
  basin(): BasinStatus;
  /** Moves this process's readers and control reader to basin generation `generation`. */
  moveTo(generation: number): void;
  /** Deletes the basins of retired generations after the grace period. */
  retire(generations: readonly number[]): void;
  /** Stops the readers and the relay, and closes what `wireStreams` created. */
  close(): Promise<void>;
}

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;
/** The longest wait between two `ensureTenant` attempts while the basin is being repaired. */
const BASIN_RETRY_MAX_MS = 5000;
/** A repair started within this long after the last one succeeded waits for the next failure. */
const BASIN_REPAIR_COOLDOWN_MS = 1000;
/** How often every session stream is checked against its session (backstop for lost signals). */
const FEED_CHECK_MS = 30_000;
/** How long a retired basin stays for readers that have not moved yet. */
const RETIRE_GRACE_MS = 60_000;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Wires the Tenant to Durable Streams: reads its basin generation, checks the basin, starts
 * the Tenant's relay (unless the Host relays), the control reader and the retired basins'
 * deletion, and records the handles on `ctx.sessionStreams.wiring`. Call it once, after
 * `ctx` is built and before the Tenant serves requests.
 */
export async function wireStreams(
  ctx: TenantContext,
  options: WireStreamsOptions
): Promise<StreamsWiring> {
  if (ctx.sessionStreams.wiring) throw new Error("Streams are already wired");
  const { store, streams, tenantId } = options;
  const logger = ctx.config.logger;
  const stop = new AbortController();
  const graceMs = options.retireGraceMs ?? RETIRE_GRACE_MS;
  // Nothing is reported once the wiring stops: the Tenant (and its log directory) may be gone,
  // and a throwing report in a detached loop would be an unhandled rejection.
  const report = (what: string) => (error: unknown) => {
    if (!stop.signal.aborted) logger.warn(what, { message: messageOf(error) });
  };

  const generations = await store.tx((t) => t.basinGenerations());
  ctx.sessionStreams.generation = generations.current;

  const basin = basinKeeper(
    streams,
    () => currentBasin(ctx),
    stop.signal,
    report("stream basin unavailable; retrying")
  );
  // Wait for the first check so the first commits find the basin; a failure repairs it later.
  await basin.ensure().catch((error: unknown) => {
    report("stream basin unavailable; relaying later")(error);
    basin.repair();
  });

  const relay = options.hostRelay
    ? undefined
    : createStreamRelay({
        source: commitSource(store, tenantId),
        record: store.record(),
        streams,
        log: (message, fields) => {
          if (!stop.signal.aborted) logger.info(message, fields);
        },
      });
  relay?.start();

  // One control reader, on the current basin; moving to a new generation restarts it there.
  let control = new AbortController();
  const startControl = () =>
    follow(
      streams,
      currentBasin(ctx),
      CONTROL_STREAM,
      AbortSignal.any([stop.signal, control.signal]),
      (body) => {
        const signal = body as Partial<ControlSignal> | null;
        if (signal?.type === "session.cancel" && typeof signal.sessionId === "string")
          ctx.abortLocal(
            signal.sessionId,
            typeof signal.turnId === "string" ? signal.turnId : undefined
          );
        else if (
          signal?.type === "action.resolved" &&
          typeof signal.sessionId === "string" &&
          typeof signal.actionId === "string"
        )
          void resolveHeld(ctx, signal.sessionId, signal.actionId).catch(
            report("held run resolution failed")
          );
        else if (signal?.type === "sessions.reset")
          void checkSessionStreams(ctx).catch(report("session stream check failed"));
      },
      report("control stream read failed; retrying")
    );
  // Signals appended from here on reach this process.
  await startControl();

  // Streams whose session was reset end on the `sessions.reset` signal; this catches lost ones.
  const feedCheck = setInterval(
    () => void checkSessionStreams(ctx).catch(report("session stream check failed")),
    FEED_CHECK_MS
  );
  feedCheck.unref();

  const retiring = new Set<number>();
  const timers = new Set<NodeJS.Timeout>();
  const wiring: StreamsWiring = {
    streams,
    relay,
    basin: () => basin.status(),
    moveTo(generation) {
      if (stop.signal.aborted || generation === ctx.sessionStreams.generation) return;
      ctx.sessionStreams.generation = generation;
      basin.repair();
      control.abort();
      control = new AbortController();
      void startControl();
    },
    retire(retired) {
      for (const generation of retired) {
        if (generation === ctx.sessionStreams.generation || retiring.has(generation)) continue;
        retiring.add(generation);
        const timer = setTimeout(() => {
          timers.delete(timer);
          void deleteRetired(generation).finally(() => retiring.delete(generation));
        }, graceMs);
        timer.unref();
        timers.add(timer);
      }
    },
    async close() {
      stop.abort();
      clearInterval(feedCheck);
      for (const timer of timers) clearTimeout(timer);
      await relay?.stop();
      if (options.ownsStreams) await streams.close();
    },
  };

  /** Deletes a retired generation's basin, then forgets it. A failure retries on next open. */
  async function deleteRetired(generation: number): Promise<void> {
    try {
      await withRetries(() => streams.deleteTenant(basinOf(tenantId, generation)), 5);
      await store.tx((t) => t.forgetRetiredGeneration(generation));
      logger.info("retired stream basin deleted", { generation });
    } catch (error) {
      report("retired stream basin not deleted; retrying when the Tenant opens")(error);
    }
  }

  ctx.sessionStreams.wiring = wiring;
  wiring.retire(generations.retired);
  return wiring;
}

/**
 * The Tenant's own commits as a change source, for a Tenant without the Host's relay. It
 * starts fresh every time (the relay reconciles the record first) and keeps nothing: a commit
 * this process did not see is found by the next reconciliation.
 */
function commitSource(store: SessionStore, tenantId: string): ChangeSource {
  let unsubscribe: (() => void) | undefined;
  let n = 0;
  return {
    start(handlers: ChangeHandlers) {
      handlers.onActive({ fresh: true });
      unsubscribe = store.onCommit((commit: Commit) => {
        n += 1;
        handlers.onTx({
          endLsn: `0/${n}`,
          rows: commit.events.map((event, i) => ({
            tenantId,
            sessionId: event.sessionId,
            seq: event.seq,
            generation: commit.generations[i]!,
            body: event,
          })),
        });
      });
    },
    acknowledge() {},
    async reconciled() {},
    async stop() {
      unsubscribe?.();
    },
  };
}

/**
 * Appends `session.cancel` for `sessionId` and its cancelled turn to `tenant/control`, so the
 * process running that turn's advance aborts it. Call it from `t.afterCommit` after a cancel
 * commits. A lost signal costs latency only (the advance checks the Session Store before every
 * effect), so failures are logged, never thrown.
 */
export function signalSessionCancel(
  ctx: TenantContext,
  sessionId: string,
  turnId: string | null
): void {
  const streams = ctx.sessionStreams.wiring?.streams;
  if (!streams) return;
  void signalCancel(streams, currentBasin(ctx), sessionId, turnId ?? undefined).catch(
    (error: unknown) =>
      ctx.config.logger.warn("cancel signal failed", {
        sessionId,
        message: messageOf(error),
      })
  );
}

/**
 * Appends `action.resolved` for an Action whose outcome just committed, so a run held for it
 * by a harness of another process goes on (F6.2). Call it from `t.afterCommit`. A lost signal
 * costs the hold's time only: the segment then ends as waiting and resumes by replay.
 */
export function signalActionOutcome(ctx: TenantContext, sessionId: string, actionId: string): void {
  const streams = ctx.sessionStreams.wiring?.streams;
  if (!streams) return;
  void signalActionResolved(streams, currentBasin(ctx), sessionId, actionId).catch((error: unknown) =>
    ctx.config.logger.warn("action resolved signal failed", { sessionId, message: messageOf(error) })
  );
}

/** Passes an Action's recorded outcome to the run of `sessionId` held here, if any. */
async function resolveHeld(ctx: TenantContext, sessionId: string, actionId: string): Promise<void> {
  if (!ctx.harness.holds(sessionId)) return;
  const effect = await ctx.store.tx((t) =>
    t.get<{ status?: string; outcome?: { value: unknown } }>("effects", actionId)
  );
  if (effect?.status === "completed" && effect.outcome)
    ctx.harness.resolved(sessionId, actionId, effect.outcome);
}

/**
 * After a reset deleted the Tenant's sessions and moved it to a new basin generation: tells
 * every process with the Tenant open (`sessions.reset` on the old basin's control stream),
 * moves this process's readers, and deletes the old basin after the grace period. Failures
 * are logged; the periodic check and the next open finish the job.
 */
export async function tenantReset(ctx: TenantContext): Promise<void> {
  const wiring = ctx.sessionStreams.wiring;
  if (!wiring) return;
  const previous = currentBasin(ctx);
  const generations = await ctx.store.tx((t) => t.basinGenerations());
  await signalSessionsReset(wiring.streams, previous, generations.current).catch(
    (error: unknown) =>
      ctx.config.logger.warn("sessions.reset signal failed", { message: messageOf(error) })
  );
  wiring.moveTo(generations.current);
  wiring.retire(generations.retired);
}

/** Tenant status of the streams seam (for `GET /v1/tenant`). */
export interface StreamsStatus {
  /** The streams' service answered a probe (`probeStreams`) within the timeout. */
  reachable: boolean;
  basin: BasinStatus;
  /** The basin generation session streams are in. */
  generation: number;
  /** The Tenant's own relay; null when the Host's relay serves it. */
  relay: StreamRelayStatus | null;
}

/** The streams seam's status for an open Tenant: S2 reachability, the basin and the relay. */
export async function streamsStatus(
  ctx: TenantContext,
  options: { probeTimeoutMs?: number } = {}
): Promise<StreamsStatus> {
  const wiring = ctx.sessionStreams.wiring;
  return {
    reachable: wiring
      ? await probe(wiring.streams, options.probeTimeoutMs ?? 2000)
      : false,
    basin: wiring?.basin() ?? { ready: false, failures: 0, lastError: null },
    generation: ctx.sessionStreams.generation,
    relay: wiring?.relay?.status() ?? null,
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

/** Close: stops the readers and relay; the observers were ended by `endAllStreams`. */
export async function closeStreams(ctx: TenantContext): Promise<void> {
  await ctx.sessionStreams.wiring?.close();
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
   * succeeds. Called after failures and after a move; a no-op while a repair runs or just
   * succeeded.
   */
  repair(): void;
  status(): BasinStatus;
}

function basinKeeper(
  streams: DurableStreams,
  basinKey: () => string,
  signal: AbortSignal,
  onError: (error: unknown) => void
): BasinKeeper {
  let ready = false;
  let readyFor: string | undefined;
  let failures = 0;
  let lastError: string | null = null;
  let attempt: Promise<void> | undefined;
  let repairing = false;
  let repairedAt = 0;

  const ensure = (): Promise<void> => {
    const key = basinKey();
    if (ready && readyFor === key) return Promise.resolve();
    attempt ??= streams
      .ensureTenant(key)
      .then(
        () => {
          ready = true;
          readyFor = key;
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
      if (ready && readyFor === basinKey() && Date.now() - repairedAt < BASIN_REPAIR_COOLDOWN_MS)
        return;
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
  basin: string,
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
          from ??= await streams.tail(basin, stream);
        } finally {
          started();
        }
        for await (const record of streams.read(basin, stream, from, {
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
