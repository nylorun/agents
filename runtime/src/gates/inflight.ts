/**
 * The model calls (and, from F4.1, the remote MCP tool calls) the gates service is running or
 * has just finished, by caller key (blueprint §15, P1.2). A call with an `Idempotency-Key` (the loop's effect id) runs under its own
 * controller, so it outlives its client: when the runtime that sent it dies or shuts down, the
 * runtime that takes the session over re-sends the call and joins it, or gets the outcome kept
 * here, instead of calling the provider again.
 *
 * In memory, one gateway only (M2): a gateway restart loses these, and a re-sent call runs
 * again (the ledger flags the duplicate). Outcomes are kept `ttlMs` after they settle; a call
 * that throws (an abort) is not kept.
 *
 * A call sent under a run token (F5) records the session and lease epoch that started it. A
 * re-send joins it only for the same session at the same or a newer epoch (the new owner after
 * a takeover, G4), and a cancel stops it only for the same session.
 */
import type { ModelGateOutcome } from "./model-gate.js";

/** A re-send whose request differs from the call already running under its key. */
export class InflightConflict extends Error {
  override readonly name = "InflightConflict";
}

/** A re-send under an older lease epoch than the call's: never joins (G4). */
export class InflightStale extends Error {
  override readonly name = "InflightStale";
}

/** The run a keyed call belongs to: its session and the lease epoch that sent it. */
export interface InflightOwner {
  readonly sessionId: string;
  readonly epoch: number;
}

export interface InflightCalls<T = ModelGateOutcome> {
  /**
   * Joins the call under `key`, or starts it with `start` under the entry's own signal.
   * Rejects with `InflightConflict` when `hash` differs from the running call's, or `owner`
   * names another session than the call's, and with `InflightStale` when `owner`'s epoch is
   * older than the call's. A call started without an owner (core's credential) is joined by
   * hash alone.
   */
  run(
    key: string,
    hash: string,
    start: (signal: AbortSignal) => Promise<T>,
    owner?: InflightOwner,
  ): Promise<T>;
  /** True while a call runs under `key`, or its outcome is still kept. */
  has(key: string): boolean;
  /**
   * Aborts the call under `key` and forgets it; nothing when there is none. With `sessionId`
   * (a run's cancel), returns false and leaves the call alone when it is another session's.
   */
  cancel(key: string, sessionId?: string): boolean;
  /** Aborts every running call (gateway shutdown). */
  close(): void;
  /** Entries held: running, or settled within the TTL. */
  readonly size: number;
}

interface Entry<T> {
  readonly hash: string;
  /** The run that started the call, then the newest that joined it. */
  owner?: InflightOwner;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  settledAt?: number;
}

export interface InflightCallsOptions {
  /** How long a settled outcome is kept. Default 30 minutes. */
  readonly ttlMs?: number;
  /** Most entries; the oldest settled ones go first. Default 10,000. */
  readonly max?: number;
  readonly now?: () => number;
}

export function createInflightCalls<T = ModelGateOutcome>(
  options: InflightCallsOptions = {},
): InflightCalls<T> {
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const max = options.max ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();

  /** Drops expired outcomes, then the oldest settled ones while over `max`. */
  function prune(): void {
    const expired = now() - ttlMs;
    for (const [key, entry] of entries)
      if (entry.settledAt !== undefined && entry.settledAt <= expired) entries.delete(key);
    if (entries.size <= max) return;
    for (const [key, entry] of entries) {
      if (entries.size <= max) break;
      if (entry.settledAt !== undefined) entries.delete(key);
    }
  }

  return {
    run(key, hash, start, owner) {
      prune();
      const existing = entries.get(key);
      if (existing) {
        if (existing.hash !== hash)
          return Promise.reject(
            new InflightConflict(`A different request is already running under ${key}`),
          );
        if (owner && existing.owner) {
          if (owner.sessionId !== existing.owner.sessionId)
            return Promise.reject(new InflightConflict(`The call under ${key} is another session's`));
          if (owner.epoch < existing.owner.epoch)
            return Promise.reject(
              new InflightStale(`A newer owner of the session holds the call under ${key}`),
            );
          existing.owner = owner;
        }
        return existing.promise;
      }
      const controller = new AbortController();
      const promise = start(controller.signal).then(
        (outcome) => {
          entry.settledAt = now();
          return outcome;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      // Nobody may be waiting (the client went away); a rejection is not an unhandled one.
      promise.catch(() => {});
      const entry: Entry<T> = { hash, controller, promise, ...(owner ? { owner } : {}) };
      entries.set(key, entry);
      return promise;
    },
    has(key) {
      prune();
      return entries.has(key);
    },
    cancel(key, sessionId) {
      const entry = entries.get(key);
      if (!entry) return true;
      if (sessionId !== undefined && entry.owner && entry.owner.sessionId !== sessionId) return false;
      entries.delete(key);
      entry.controller.abort(new Error("The caller cancelled the call"));
      return true;
    },
    close() {
      for (const entry of entries.values())
        if (entry.settledAt === undefined)
          entry.controller.abort(new Error("The gateway is shutting down"));
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
