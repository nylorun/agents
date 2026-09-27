/**
 * The Durable Session Execution seam (architecture §12.3).
 *
 * Durable Session Execution decides when to look at a session again. It never
 * holds session state: every outcome lives in the Session Store, and `advance`
 * is safe to repeat (§10.1). Restate is the supported implementation
 * (`adapters/execution/restate.ts`); `execution/memory.ts` is the in-process
 * implementation used by unit tests and, until Wave 3, by the Runtime.
 *
 * ## Guarantees every implementation keeps
 *
 * - **One advance per key at a time.** The key is `<tenantId>:<sessionId>`.
 *   Two `advance` calls for one key never overlap, on one process or many.
 *   Different keys may run concurrently.
 * - **At least once after a wake.** When `wake` resolves, an `advance` for the
 *   key will start after that point (possibly merged with other wakes). Wakes
 *   are sent after the Session Store transaction that caused them commits
 *   (`Tx.afterCommit`), never inside it.
 * - **Dedupe.** Wakes carrying the same `dedupeKey` for the same key cause at
 *   most one advance for that cause (within the implementation's retention
 *   window, at least 24 hours for Restate).
 * - **Busy re-wake.** An advance that returns `busy` is re-run for the same key
 *   after `retryAfterMs`.
 * - **Retries on infrastructure errors.** A handler that throws is retried with
 *   backoff. Session outcomes never throw: a turn that fails, pauses, waits or
 *   becomes `uncertain` is settled in the Session Store and `advance` returns
 *   `done`.
 * - **Sweeps.** `armSweep` arms one self-re-arming sweep per Tenant; arming an
 *   armed Tenant is a no-op. The sweep expires claims, re-wakes orphaned
 *   `runnable` sessions and relays outbox rows left behind.
 */

/** Why a session is woken (§12.3, "Where wakes come from"). */
export type WakeReason =
  /** Session commands. */
  | "message"
  | "approve"
  | "respond"
  /** An executor posted an Action result. */
  | "action_result"
  /** A linked agent turn completed, failed or was cancelled. */
  | "linked"
  /** Queued flow effects, pending agent effects reconciled. */
  | "flow"
  /** The Tenant sweep and `busy` re-wakes. */
  | "recover";

export const WAKE_REASONS: readonly WakeReason[] = [
  "message",
  "approve",
  "respond",
  "action_result",
  "linked",
  "flow",
  "recover",
];

export interface Wake {
  reason: WakeReason;
  /**
   * Merges repeated wakes for the same cause, e.g. the command's idempotency
   * key. Scoped to the session key. Absent means never deduped.
   */
  dedupeKey?: string;
}

export type AdvanceResult =
  | { status: "done" }
  /** Another Worker holds a live lease; run again for this key after `retryAfterMs`. */
  | { status: "busy"; retryAfterMs: number };

/** What a Worker runs when Durable Session Execution calls it. */
export interface WorkerHandlers {
  /**
   * Advances one session (§10.5). `signal` aborts when the Worker stops or the
   * session is cancelled through the control stream. Throw only on
   * infrastructure errors.
   */
  advance(
    tenantId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AdvanceResult>;
  /** One pass of the Tenant sweep. Re-armed by the implementation afterwards. */
  sweep(tenantId: string): Promise<void>;
  /** A durable timer set with `timer` fired. Required when `timer` is used. */
  fire?(tenantId: string, key: string): Promise<void>;
}

export interface DurableExecution {
  /** At-least-once. `dedupeKey` merges repeated wakes for the same cause. */
  wake(tenantId: string, sessionId: string, wake: Wake): Promise<void>;
  /**
   * Durable one-shot timer that calls `WorkerHandlers.fire(tenantId, key)` at
   * or after `at`. Setting a key again replaces the earlier time where the
   * implementation can; `fire` must be idempotent either way.
   */
  timer(tenantId: string, key: string, at: Date): Promise<void>;
  /** Arms the Tenant's self-re-arming sweep. Idempotent. */
  armSweep(tenantId: string): Promise<void>;
  /** Stops re-arming the Tenant's sweep (Tenant deleted). A pass already running finishes. */
  disarmSweep(tenantId: string): Promise<void>;
  /** Starts delivering to `handlers` (serving the Worker endpoint, for Restate). */
  start(handlers: WorkerHandlers): Promise<void>;
  /** Stops delivering, aborts running advances' signals and waits for them. */
  stop(): Promise<void>;
  /**
   * Resolves when the backing service answers, rejects otherwise (readiness,
   * `infra/execution.ts`). Absent for in-process implementations.
   */
  probe?(signal: AbortSignal): Promise<void>;
  /**
   * Invocations for `tenantId` that need an operator: paused after exhausting
   * retries, or backing off after failures (Tenant status). Absent for
   * in-process implementations.
   */
  stuckInvocations?(tenantId: string): Promise<StuckInvocation[]>;
}

/** An invocation that needs an operator (`DurableExecution.stuckInvocations`). */
export interface StuckInvocation {
  id: string;
  /** `paused` or `backing-off`. */
  status: string;
  /** Service name without any prefix, e.g. `NylorunSession`. */
  service: string;
  handler: string;
  /** Object key: `<tenantId>:<sessionId>`, `<tenantId>` or `<tenantId>:<timer key>`. */
  key: string;
  tenantId?: string;
  retryCount: number;
  lastFailure?: string;
  modifiedAt?: string;
}

/** The key one advance at a time is serialized on. */
export function sessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

/** Splits a key made by `sessionKey`. Tenant ids never contain `:`. */
export function parseSessionKey(key: string): {
  tenantId: string;
  sessionId: string;
} {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1)
    throw new Error(`Invalid session key: ${key}`);
  return { tenantId: key.slice(0, at), sessionId: key.slice(at + 1) };
}
