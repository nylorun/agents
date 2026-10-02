/**
 * The model calls the gates service is running or has just finished, by caller key (blueprint
 * §15, P1.2). A call with an `Idempotency-Key` (the loop's effect id) runs under its own
 * controller, so it outlives its client: when the runtime that sent it dies or shuts down, the
 * runtime that takes the session over re-sends the call and joins it, or gets the outcome kept
 * here, instead of calling the provider again.
 *
 * In memory, one gateway only (M2): a gateway restart loses these, and a re-sent call runs
 * again (the ledger flags the duplicate). Outcomes are kept `ttlMs` after they settle; a call
 * that throws (an abort) is not kept.
 */
import type { ModelGateOutcome } from "./model-gate.js";

/** A re-send whose request differs from the call already running under its key. */
export class InflightConflict extends Error {
  override readonly name = "InflightConflict";
}

export interface InflightCalls {
  /**
   * Joins the call under `key`, or starts it with `start` under the entry's own signal.
   * Rejects with `InflightConflict` when `hash` differs from the running call's.
   */
  run(
    key: string,
    hash: string,
    start: (signal: AbortSignal) => Promise<ModelGateOutcome>,
  ): Promise<ModelGateOutcome>;
  /** Aborts the call under `key` and forgets it; nothing when there is none. */
  cancel(key: string): void;
  /** Aborts every running call (gateway shutdown). */
  close(): void;
  /** Entries held: running, or settled within the TTL. */
  readonly size: number;
}

interface Entry {
  readonly hash: string;
  readonly controller: AbortController;
  readonly promise: Promise<ModelGateOutcome>;
  settledAt?: number;
}

export interface InflightCallsOptions {
  /** How long a settled outcome is kept. Default 30 minutes. */
  readonly ttlMs?: number;
  /** Most entries; the oldest settled ones go first. Default 10,000. */
  readonly max?: number;
  readonly now?: () => number;
}

export function createInflightCalls(options: InflightCallsOptions = {}): InflightCalls {
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const max = options.max ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

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
    run(key, hash, start) {
      prune();
      const existing = entries.get(key);
      if (existing) {
        if (existing.hash !== hash)
          return Promise.reject(
            new InflightConflict(`A different request is already running under ${key}`),
          );
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
      const entry: Entry = { hash, controller, promise };
      entries.set(key, entry);
      return promise;
    },
    cancel(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      entry.controller.abort(new Error("The caller cancelled the model call"));
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
