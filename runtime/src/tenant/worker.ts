/**
 * The Worker side of Durable Session Execution (architecture §12.3): what a `DurableExecution`
 * calls for the Tenant, and the registry its handlers dispatch through by Tenant id.
 *
 * - `TenantWorker` is one open Tenant's handlers: `advance(sessionId, signal)` (§10.5, in
 *   `advance.ts`), `sweep()` (the Tenant sweep, in `sweep.ts`) and, optionally,
 *   `deliver(actionId, signal)` (one Action to its Action endpoint).
 * - `TenantWorkers` is the registry. Its `handlers` are the `WorkerHandlers` an execution is
 *   started with; they dispatch by `tenantId` to the registered `TenantWorker`. A Tenant
 *   registers when it opens and unregisters when it closes. A call for a Tenant that is not
 *   open here asks the optional `resolve` hook (the Host's, which waits for its Tenant to
 *   open, and knows no other); without one,
 *   the advance and the delivery return `done` and the sweep does nothing. Nothing is lost:
 *   the Tenant's sweep re-wakes its orphaned sessions once it is open again, and an Action
 *   that was not delivered stays pending.
 * - `TenantExecution` pairs an execution with its registry. The Host creates one per process
 *   (`host/execution.ts`) and passes it to its Tenant; a Tenant opened without one
 *   (tests, ephemeral) gets its own in-process `MemoryExecution`.
 *
 * ## Advance deadline
 *
 * Restate's abort timeout does not interrupt a running handler (the advance's signal does not
 * fire), so the registry bounds every advance itself:
 *
 * 1. At `advanceDeadlineMs` the advance's signal aborts with an `AdvanceDeadlineError`. The
 *    in-flight effect is aborted and the segment settles as a normal outcome (the effect and
 *    the turn become `uncertain`, or the turn fails with the deadline's message).
 * 2. Once the signal has aborted, for whatever reason (deadline, Worker stop, Restate attempt
 *    end), the advance has `advanceGraceMs` to return. One that does not (an effect that
 *    ignores its signal) is abandoned: the handler returns `busy`, so the execution runs the
 *    session again. The abandoned advance has stopped renewing its lease (`advance.ts`), so
 *    the next advance takes over when the lease lapses (§11.4), and the epoch fences anything
 *    the abandoned one still tries to write.
 *
 * ## Abort reasons
 *
 * Every abort of an advance carries an `AdvanceAbort` whose `kind` says why, because the
 * advance treats them differently (`advance.ts`, `effects.ts`):
 *
 * - `cancel`: a user cancel (or a reset) committed first. Results that arrive afterwards are
 *   discarded and the turn stays cancelled (§10.7).
 * - `deadline`: the advance ran too long (`AdvanceDeadlineError`). The segment settles as a
 *   normal outcome.
 * - `shutdown`: this Worker gives the advance up (Worker stop, Tenant close, the Restate
 *   attempt ended). Nothing about the turn is settled: outcomes already in hand are recorded,
 *   ownership is released and the advance returns `busy`, so the next advance, here or on
 *   another Worker, resumes the segment from its checkpoint with the cached outcomes.
 * - `ownership.lost`: another advance took the session over; this one writes nothing more.
 *
 * An abort that arrives through the execution's signal is a `shutdown`, whatever its reason.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { AbortReason } from "@nylorun/core/harness-api";
import { RunAbort } from "@nylorun/harness/api";
import type {
  AdvanceResult,
  DeliverResult,
  DurableExecution,
  StuckInvocation,
  WorkerHandlers,
} from "../execution/types.js";
import type { Logger } from "./types.js";

/** This process's Worker id: the `owner` it writes on the sessions it advances (§10.6). */
export const WORKER_ID = `worker-${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;

/**
 * Default advance deadline: 50 minutes, below the one-hour inactivity and abort timeouts the
 * Restate adapter sets on the session object, so an advance always ends before Restate gives
 * up on it.
 */
export const DEFAULT_ADVANCE_DEADLINE_MS = 50 * 60_000;
/** Default time an aborted advance has to settle before it is abandoned. */
export const DEFAULT_ADVANCE_GRACE_MS = 30_000;

/** Why an advance's signal aborted (see "Abort reasons" above). */
export type AdvanceAbortKind = AbortReason;

/**
 * The abort reason of an advance. A harness run's reason (`RunAbort`) has the same kinds, so the
 * executors read either one.
 */
export class AdvanceAbort extends RunAbort {
  override readonly name: string = "AdvanceAbort";
  constructor(kind: AdvanceAbortKind, message: string, options?: { cause?: unknown }) {
    super(kind, message, options);
  }
}

/** The abort reason of an advance that ran past its deadline. */
export class AdvanceDeadlineError extends AdvanceAbort {
  override readonly name = "AdvanceDeadlineError";
  constructor(readonly deadlineMs: number) {
    super("deadline", `The advance ran past its ${deadlineMs} ms deadline`);
  }
}

/**
 * The kind of an aborted signal's reason, or `undefined` while it has not aborted. A reason
 * that is not an `AdvanceAbort` came from outside the Tenant (the execution stopping) and
 * counts as `shutdown`.
 */
export function abortKind(signal: AbortSignal): AdvanceAbortKind | undefined {
  if (!signal.aborted) return undefined;
  return signal.reason instanceof RunAbort ? signal.reason.kind : "shutdown";
}

/** The execution's abort reason as a `shutdown`, keeping its message. */
function shutdownOf(reason: unknown): AdvanceAbort {
  if (reason instanceof AdvanceAbort) return reason;
  return new AdvanceAbort(
    "shutdown",
    reason instanceof Error ? reason.message : "The Worker stopped the advance",
    { cause: reason }
  );
}

/** One open Tenant's handlers. */
export interface TenantWorker {
  /** Advances one session. Session outcomes never throw; only infrastructure errors do. */
  advance(sessionId: string, signal: AbortSignal): Promise<AdvanceResult>;
  /** One pass of the Tenant sweep. */
  sweep(): Promise<void>;
  /** Delivers one Action to its endpoint. Only infrastructure errors throw. */
  deliver?(actionId: string, signal: AbortSignal): Promise<DeliverResult>;
}

export interface TenantWorkersOptions {
  /** Finds or opens a Tenant that is not registered on this process. */
  resolve?: (tenantId: string) => Promise<TenantWorker | undefined>;
  /** How long one advance may run before its signal aborts. Default `DEFAULT_ADVANCE_DEADLINE_MS`. */
  advanceDeadlineMs?: number;
  /**
   * How long an advance whose signal aborted has to return before it is abandoned.
   * Default `DEFAULT_ADVANCE_GRACE_MS`.
   */
  advanceGraceMs?: number;
  /** Receives a warning for each abandoned advance. */
  logger?: Logger;
}

const DONE = { status: "done" } as const;

/** Registry of open Tenants' workers, dispatched to by `tenantId`. */
export class TenantWorkers {
  private readonly workers = new Map<string, TenantWorker>();
  private readonly deadlineMs: number;
  /**
   * How long an aborted advance has to return before it is abandoned. Closing a Tenant waits
   * as long for its advances before it abandons them (`scheduler.ts` `waitForIdle`).
   */
  readonly graceMs: number;

  constructor(private readonly options: TenantWorkersOptions = {}) {
    this.deadlineMs = positive(
      "advanceDeadlineMs",
      options.advanceDeadlineMs ?? DEFAULT_ADVANCE_DEADLINE_MS
    );
    this.graceMs = positive(
      "advanceGraceMs",
      options.advanceGraceMs ?? DEFAULT_ADVANCE_GRACE_MS
    );
  }

  /** Registers an open Tenant's worker; the returned function unregisters exactly it. */
  register(tenantId: string, worker: TenantWorker): () => void {
    this.workers.set(tenantId, worker);
    return () => {
      if (this.workers.get(tenantId) === worker) this.workers.delete(tenantId);
    };
  }

  get(tenantId: string): TenantWorker | undefined {
    return this.workers.get(tenantId);
  }

  private async find(tenantId: string): Promise<TenantWorker | undefined> {
    return this.workers.get(tenantId) ?? (await this.options.resolve?.(tenantId));
  }

  /** The handlers to start a `DurableExecution` with. */
  readonly handlers: WorkerHandlers = {
    advance: async (tenantId, sessionId, signal) => {
      const worker = await this.find(tenantId);
      return worker ? this.bounded(tenantId, sessionId, worker, signal) : DONE;
    },
    sweep: async (tenantId) => {
      await (await this.find(tenantId))?.sweep();
    },
    deliver: async (tenantId, actionId, signal) => {
      const worker = await this.find(tenantId);
      return worker?.deliver ? worker.deliver(actionId, signal) : DONE;
    },
  };

  /** Runs one advance under the deadline and the grace period (see the module comment). */
  private async bounded(
    tenantId: string,
    sessionId: string,
    worker: TenantWorker,
    signal: AbortSignal
  ): Promise<AdvanceResult> {
    const controller = new AbortController();
    const abort = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const forward = () => abort(shutdownOf(signal.reason));
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    const deadline = setTimeout(
      () => abort(new AdvanceDeadlineError(this.deadlineMs)),
      this.deadlineMs
    );
    let grace: NodeJS.Timeout | undefined;
    let armGrace: (() => void) | undefined;
    const abandoned = new Promise<AdvanceResult>((resolve) => {
      armGrace = () => {
        grace = setTimeout(() => {
          this.options.logger?.warn("advance abandoned after abort", {
            tenantId,
            sessionId,
            graceMs: this.graceMs,
            reason:
              controller.signal.reason instanceof Error
                ? controller.signal.reason.message
                : String(controller.signal.reason),
          });
          resolve({ status: "busy", retryAfterMs: 0 });
        }, this.graceMs);
      };
      if (controller.signal.aborted) armGrace();
      else controller.signal.addEventListener("abort", armGrace, { once: true });
    });
    try {
      // `race` keeps handling the advance's outcome after it is abandoned.
      return await Promise.race([worker.advance(sessionId, controller.signal), abandoned]);
    } finally {
      clearTimeout(deadline);
      clearTimeout(grace);
      signal.removeEventListener("abort", forward);
      if (armGrace) controller.signal.removeEventListener("abort", armGrace);
    }
  }
}

/** A Durable Session Execution together with the registry its handlers dispatch through. */
export interface TenantExecution {
  readonly execution: DurableExecution;
  readonly workers: TenantWorkers;
  /**
   * The Tenant's invocations that need an operator (paused or backing off), for Tenant
   * status. Absent when the execution cannot report them (in-process execution).
   */
  readonly stuckInvocations?: (tenantId: string) => Promise<StuckInvocation[]>;
}

/** The longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS)
    throw new Error(`${name} must be positive and at most ${MAX_TIMEOUT_MS}`);
  return value;
}
