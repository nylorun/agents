/**
 * The Durable Session Execution seam (architecture §12.3).
 *
 * Durable Session Execution decides when to look at a session again. It never
 * holds session state: every outcome lives in the Session Store, and `advance`
 * is safe to repeat (§10.1). Restate is the supported implementation
 * (`adapters/execution/restate.ts`); `execution/memory.ts` is the in-process
 * implementation used by unit tests, `startEphemeralRuntime` and a Host
 * started without Restate endpoints.
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
 *   armed Tenant is a no-op. The sweep settles lapsed deliveries and re-wakes
 *   orphaned `runnable` sessions.
 * - **One delivery per Action at a time.** `deliver` runs
 *   `WorkerHandlers.deliver` for the key `<tenantId>:<actionId>` at least once
 *   after it resolves. Two deliveries for one key never overlap; repeated
 *   `deliver` calls may each run it, so the handler reads the Action's state
 *   and does nothing when there is nothing to deliver.
 * - **Retry after `retry`.** A delivery that returns `retry` is run again for
 *   the same key after `retryAfterMs`. This is how an Action endpoint that is
 *   down or busy is retried; the handler throws only on infrastructure errors.
 * - **One reconcile per sandbox at a time** (F7.2). `sandbox` runs
 *   `WorkerHandlers.sandbox` for the key `<tenantId>:<sandboxId>` at least once
 *   after a `reconcile` resolves, never overlapping another run for the key. A
 *   run that answers `retryAfterMs` runs again after it (one pending retry per
 *   key: a later one replaces it), and each timer it answers is armed. `arm`
 *   sets one of the sandbox's timers (`idle`, `ttl`): setting it again replaces
 *   the earlier time, and the run it causes is told which timer fired.
 */

/** Why a session is woken (§12.3, "Where wakes come from"). */
export type WakeReason =
  /** Session commands. */
  | "message"
  | "approve"
  | "respond"
  /** An Action's outcome was recorded (a delivery's answer or a background result). */
  | "action_result"
  /** A linked agent turn completed, failed or was cancelled. */
  | "linked"
  /** Queued flow effects, pending agent effects reconciled. */
  | "flow"
  /** The Tenant sweep and `busy` re-wakes. */
  | "recover"
  /** A long turn ended a segment at a step boundary and continues in the next (Model Calls §10). */
  | "rollover";

export const WAKE_REASONS: readonly WakeReason[] = [
  "message",
  "approve",
  "respond",
  "action_result",
  "linked",
  "flow",
  "recover",
  "rollover",
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

/** A pod sandbox's timers. */
export type SandboxTimer = "idle" | "ttl";

/** What `DurableExecution.sandbox` asks for: a reconcile, or a timer. */
export type SandboxSignal =
  | { kind: "reconcile" }
  | { kind: "arm"; timer: SandboxTimer; at: number };

/** Why `WorkerHandlers.sandbox` runs. */
export type SandboxTrigger = "reconcile" | SandboxTimer;

/** What a sandbox reconcile asks for next. */
export interface SandboxResult {
  /** Run again this soon. */
  retryAfterMs?: number;
  /** Timers to set, at ms since the epoch. */
  arm?: readonly { timer: SandboxTimer; at: number }[];
}

export type DeliverResult =
  | { status: "done" }
  /** The Action is still to be delivered; run again for this key after `retryAfterMs`. */
  | { status: "retry"; retryAfterMs: number };

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
  /**
   * Delivers one Action to its Action endpoint. `signal` aborts when the Worker
   * stops. Throw only on infrastructure errors. Required when `deliver` is used.
   */
  deliver?(
    tenantId: string,
    actionId: string,
    signal: AbortSignal,
  ): Promise<DeliverResult>;
  /**
   * Reconciles one pod sandbox (F7.2), serialized per sandbox. Throw only on infrastructure
   * errors. Required when `sandbox` is used.
   */
  sandbox?(
    tenantId: string,
    sandboxId: string,
    trigger: SandboxTrigger,
    signal: AbortSignal,
  ): Promise<SandboxResult>;
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
  /**
   * At-least-once: `WorkerHandlers.deliver(tenantId, actionId)` runs after this
   * resolves, never overlapping another delivery of the same Action. Send it
   * after the transaction that made the Action pending commits.
   */
  deliver(tenantId: string, actionId: string): Promise<void>;
  /**
   * A pod sandbox's reconcile, or one of its timers (F7.2): see "One reconcile per sandbox
   * at a time". Absent where pods are not supported.
   */
  sandbox?(tenantId: string, sandboxId: string, signal: SandboxSignal): Promise<void>;
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
  /**
   * Object key: `<tenantId>:<sessionId>`, `<tenantId>`, `<tenantId>:<timer key>` or
   * `<tenantId>:<actionId>`.
   */
  key: string;
  tenantId?: string;
  retryCount: number;
  lastFailure?: string;
  modifiedAt?: string;
}

/** The key one advance (or one delivery, with an Action id) at a time is serialized on. */
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
