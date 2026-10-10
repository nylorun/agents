/**
 * Waiting and retrying, shared by the Runtime's background loops and its calls to other
 * services. Nothing here logs or decides what is worth retrying: callers do.
 */
import { setTimeout as delay } from "node:timers/promises";

/** Waits `ms`, or until `signal` aborts; resolves either way and never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, signal ? { signal } : undefined).catch(() => undefined);
}

export interface RetryOptions {
  /** The first wait after a failure. Doubled after each, up to `maxMs`. */
  minMs: number;
  maxMs: number;
  /** Attempts, the first included, before giving up. Default: no limit. */
  attempts?: number;
  /** Gives up when the next wait would end later than this long after the first attempt. */
  deadlineMs?: number;
  /** Gives up when it aborts, after the attempt or wait under way. */
  signal?: AbortSignal;
  /** Called with each failure that is retried, and how many attempts have failed so far. */
  onError?: (error: unknown, failures: number) => void;
}

/**
 * Runs `attempt` until it resolves, waiting between failures with exponential backoff
 * (`minMs`, doubling to `maxMs`). Rejects with the last failure once `attempts`, `deadlineMs`
 * or `signal` ends the retries.
 */
export async function retry<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  const deadline = options.deadlineMs === undefined ? Infinity : Date.now() + options.deadlineMs;
  let wait = options.minMs;
  for (let failures = 1; ; failures += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        failures >= (options.attempts ?? Infinity) ||
        Date.now() + wait > deadline ||
        options.signal?.aborted
      )
        throw error;
      options.onError?.(error, failures);
      await sleep(wait, options.signal);
      if (options.signal?.aborted) throw error;
      wait = Math.min(wait * 2, options.maxMs);
    }
  }
}
