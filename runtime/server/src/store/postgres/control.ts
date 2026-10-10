/**
 * The control bus on Postgres (blueprint D21, D48): how one process tells the others with the
 * Tenant open to act now. `session.cancel` aborts the advance of a cancelled turn;
 * `sessions.reset` moves the session streams to the Tenant's new basin generation;
 * `host.revoked` closes a pod sandbox's host connections of an older epoch. Nothing
 * internal goes through S2, which only serves API listeners.
 *
 * - **Write.** `writeSignal` inserts a `control_signals` row and calls `pg_notify` on
 *   `nylorun_control`, in the caller's transaction. Postgres sends the notification to every
 *   listening session when the transaction commits and drops it on rollback, so a signal
 *   exists exactly when what it announces committed.
 * - **Follow.** `followControlSignals` holds one connection of its own that LISTENs (a pooled
 *   connection cannot). Each notification reads back the signals of the last
 *   `WINDOW_SECONDS` and delivers those this follower has not delivered yet. So does a poll
 *   every `pollMs`, and every LISTEN after a reconnect: Postgres does not queue notifications
 *   for a session that is not connected, and the rows are what catches up. Ids are never read
 *   as a cursor: they are allocated at insert and commit out of order, so a later id can be
 *   visible first.
 * - **Start.** A follower delivers the signals written from its start on (the database's
 *   clock), never older ones.
 * - **Prune.** A row outlives its notification only for the read-back; the Tenant sweep
 *   deletes old ones (`pruneSignals`).
 */
import { gte, lt, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { ControlSignal, FollowSignalsOptions, SignalFollower } from "../types.js";
import { createPostgresListenClient } from "./connect.js";
import type { Database, Queryable } from "./db.js";
import { controlSignals } from "./schema.js";

/** The channel every signal is notified on. */
export const CONTROL_CHANNEL = "nylorun_control";
/** How far back a read-back looks. Longer than the poll, so a missed notification is caught. */
const WINDOW_SECONDS = 120;
const POLL_MS = 5000;
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 5000;

const SIGNAL = {
  id: controlSignals.id,
  kind: controlSignals.kind,
  sessionId: controlSignals.sessionId,
  turnId: controlSignals.turnId,
  generation: controlSignals.generation,
  sandboxId: controlSignals.sandboxId,
  epoch: controlSignals.epoch,
};
type SignalRow = {
  id: number;
  kind: string;
  sessionId: string | null;
  turnId: string | null;
  generation: number | null;
  sandboxId: string | null;
  epoch: number | null;
};

/** Puts `signal` on the bus in the transaction `db` runs: a row, notified at commit. */
export async function writeSignal(db: Queryable, signal: ControlSignal): Promise<void> {
  const [row] = await db
    .insert(controlSignals)
    .values({
      kind: signal.type,
      sessionId: signal.type === "session.cancel" ? signal.sessionId : null,
      turnId: signal.type === "session.cancel" ? (signal.turnId ?? null) : null,
      generation: signal.type === "sessions.reset" ? signal.generation : null,
      sandboxId: signal.type === "host.revoked" ? signal.sandboxId : null,
      epoch: signal.type === "host.revoked" ? signal.epoch : null,
    })
    .returning({ id: controlSignals.id });
  // The payload is only the id: a follower reads the rows back either way.
  await db.execute(sql`SELECT pg_notify(${CONTROL_CHANNEL}, ${String(row!.id)})`);
}

/** Deletes the signals written before `before`; returns how many. */
export async function pruneSignals(db: Queryable, before: Date): Promise<number> {
  const deleted = await db
    .delete(controlSignals)
    .where(lt(controlSignals.createdAt, before.toISOString()))
    .returning({ id: controlSignals.id });
  return deleted.length;
}

/**
 * Follows the bus on `source`'s database (`SessionStore.followSignals`). Resolves once the
 * start is fixed; the first LISTEN may still be retrying, and the poll covers it meanwhile.
 */
export async function followControlSignals(
  source: Sql,
  db: Database,
  onSignal: (signal: ControlSignal) => void,
  options: FollowSignalsOptions = {},
): Promise<SignalFollower> {
  const pollMs = options.pollMs ?? POLL_MS;
  const onError = options.onError ?? (() => {});
  // Drizzle leaves timestamps to its column types, so a raw read of one is text.
  const [start] = await db.execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`);
  const since = start!.now;
  /** Ids delivered, with when (this process's clock), until no read-back can return them. */
  const delivered = new Map<number, number>();
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let delay = RETRY_MIN_MS;
  let draining: Promise<void> | undefined;
  let again = false;

  const client = createPostgresListenClient(source, {
    onNotify: (channel) => {
      if (channel === CONTROL_CHANNEL) drain();
    },
    // The connection ended (Postgres restarted, the network dropped): listen again, which
    // connects again, and read back what was missed meanwhile.
    onClose: () => relisten(),
  });

  function relisten(): void {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void listen();
    }, delay);
    retry.unref();
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }

  async function listen(): Promise<void> {
    if (stopped) return;
    try {
      await client.unsafe(`LISTEN ${CONTROL_CHANNEL}`);
      delay = RETRY_MIN_MS;
      drain();
    } catch (error) {
      if (stopped) return;
      onError(error);
      relisten();
    }
  }

  function drain(): void {
    if (stopped) return;
    if (draining) {
      again = true;
      return;
    }
    draining = (async () => {
      do {
        again = false;
        try {
          const rows = await db
            .select(SIGNAL)
            .from(controlSignals)
            .where(
              gte(
                controlSignals.createdAt,
                sql`greatest(${since}::timestamptz, clock_timestamp() - make_interval(secs => ${WINDOW_SECONDS}))`,
              ),
            )
            .orderBy(controlSignals.id);
          for (const row of rows) deliver(row);
        } catch (error) {
          if (!stopped) onError(error);
        }
        forgetOld();
      } while (again && !stopped);
    })().finally(() => {
      draining = undefined;
    });
  }

  function deliver(row: SignalRow): void {
    if (stopped || delivered.has(row.id)) return;
    delivered.set(row.id, Date.now());
    const signal = signalOf(row);
    if (!signal) return;
    try {
      onSignal(signal);
    } catch (error) {
      onError(error);
    }
  }

  /** A row a read-back can still return is younger than the window: keep twice that. */
  function forgetOld(): void {
    const before = Date.now() - 2 * WINDOW_SECONDS * 1000;
    for (const [id, at] of delivered) if (at < before) delivered.delete(id);
  }

  const poll = setInterval(drain, pollMs);
  poll.unref();
  await listen();

  return {
    async close() {
      stopped = true;
      clearInterval(poll);
      if (retry) clearTimeout(retry);
      await draining;
      await client.end({ timeout: 0 });
    },
  };
}

function signalOf(row: SignalRow): ControlSignal | undefined {
  if (row.kind === "session.cancel" && row.sessionId !== null)
    return {
      type: "session.cancel",
      sessionId: row.sessionId,
      ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    };
  if (row.kind === "sessions.reset" && row.generation !== null)
    return { type: "sessions.reset", generation: row.generation };
  if (row.kind === "host.revoked" && row.sandboxId !== null && row.epoch !== null)
    return { type: "host.revoked", sandboxId: row.sandboxId, epoch: row.epoch };
  return undefined;
}
