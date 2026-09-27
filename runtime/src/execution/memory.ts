import {
  WAKE_REASONS,
  sessionKey,
  type DurableExecution,
  type Wake,
  type WorkerHandlers,
} from "./types.js";

export interface MemoryExecutionOptions {
  /** Delay between sweep passes of one Tenant. Default 5000. */
  sweepIntervalMs?: number;
  /** First retry delay after `advance` throws; doubles per attempt. Default 50. */
  retryDelayMs?: number;
  /** Attempts before giving up on a throwing `advance` and reporting it. Default 5. */
  maxAttempts?: number;
  /** How long a dedupe key merges repeated wakes. Default 24 hours. */
  dedupeRetentionMs?: number;
  /** Receives handler failures that are not retried. */
  onError?: (error: unknown) => void;
}

interface KeyState {
  tenantId: string;
  sessionId: string;
  running: boolean;
  queued: boolean;
  attempts: number;
  controller?: AbortController;
}

interface PendingTimer {
  tenantId: string;
  key: string;
  at: number;
  handle?: NodeJS.Timeout;
}

interface Sweep {
  handle?: NodeJS.Timeout;
  running: boolean;
}

/**
 * In-process `DurableExecution`. Not durable: wakes, timers and sweeps live in
 * memory. It keeps the seam's ordering guarantees within one process, which is
 * what unit tests and the Runtime before Restate (Wave 2) need.
 */
export class MemoryExecution implements DurableExecution {
  private handlers?: WorkerHandlers;
  private readonly keys = new Map<string, KeyState>();
  /** Dedupe keys seen, with the time each was first seen; insertion order is age order. */
  private readonly seen = new Map<string, number>();
  private readonly timers = new Map<string, PendingTimer>();
  private readonly sweeps = new Map<string, Sweep>();
  private readonly delayed = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly sweepIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly dedupeRetentionMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(options: MemoryExecutionOptions = {}) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.dedupeRetentionMs = options.dedupeRetentionMs ?? 24 * 60 * 60_000;
    this.onError =
      options.onError ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
  }

  async wake(tenantId: string, sessionId: string, wake: Wake): Promise<void> {
    if (!WAKE_REASONS.includes(wake.reason))
      throw new Error(`Unknown wake reason: ${String(wake.reason)}`);
    const key = sessionKey(tenantId, sessionId);
    if (wake.dedupeKey !== undefined) {
      const now = Date.now();
      this.forgetDedupeKeys(now);
      const dedupe = `${key}\u0000${wake.dedupeKey}`;
      if (this.seen.has(dedupe)) return;
      this.seen.set(dedupe, now);
    }
    this.enqueue(tenantId, sessionId);
  }

  async timer(tenantId: string, key: string, at: Date): Promise<void> {
    const id = `${tenantId}\u0000${key}`;
    const existing = this.timers.get(id);
    if (existing?.handle) clearTimeout(existing.handle);
    const timer: PendingTimer = { tenantId, key, at: at.getTime() };
    this.timers.set(id, timer);
    if (this.handlers) this.armTimer(id, timer);
  }

  async armSweep(tenantId: string): Promise<void> {
    if (this.sweeps.has(tenantId)) return;
    const sweep: Sweep = { running: false };
    this.sweeps.set(tenantId, sweep);
    if (this.handlers) this.scheduleSweep(tenantId, sweep, 0);
  }

  async disarmSweep(tenantId: string): Promise<void> {
    const sweep = this.sweeps.get(tenantId);
    if (sweep?.handle) clearTimeout(sweep.handle);
    this.sweeps.delete(tenantId);
  }

  async start(handlers: WorkerHandlers): Promise<void> {
    if (this.handlers) throw new Error("DurableExecution already started");
    this.handlers = handlers;
    for (const state of this.keys.values())
      if (state.queued && !state.running) this.drain(state);
    for (const [id, timer] of this.timers) this.armTimer(id, timer);
    for (const [tenantId, sweep] of this.sweeps)
      this.scheduleSweep(tenantId, sweep, 0);
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    for (const handle of this.delayed) clearTimeout(handle);
    this.delayed.clear();
    for (const timer of this.timers.values())
      if (timer.handle) clearTimeout(timer.handle);
    for (const sweep of this.sweeps.values())
      if (sweep.handle) clearTimeout(sweep.handle);
    for (const state of this.keys.values()) state.controller?.abort();
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
  }

  /**
   * Resolves once no advance is running or queued and no busy or retry
   * re-wake is pending. Timers and sweeps are not waited for. Test helper.
   */
  async idle(): Promise<void> {
    while (
      this.delayed.size > 0 ||
      this.inflight.size > 0 ||
      [...this.keys.values()].some((s) => s.running || (s.queued && this.handlers))
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private enqueue(tenantId: string, sessionId: string): void {
    const key = sessionKey(tenantId, sessionId);
    let state = this.keys.get(key);
    if (!state)
      this.keys.set(
        key,
        (state = {
          tenantId,
          sessionId,
          running: false,
          queued: false,
          attempts: 0,
        }),
      );
    state.queued = true;
    if (!state.running && this.handlers) this.drain(state);
  }

  private drain(state: KeyState): void {
    state.running = true;
    this.track(
      (async () => {
        try {
          while (state.queued && this.handlers) {
            state.queued = false;
            await this.advanceOnce(state, this.handlers);
          }
        } finally {
          state.running = false;
          // Idle keys hold nothing (a retry keeps its attempt count); forget them so
          // long-lived processes stay small.
          const key = sessionKey(state.tenantId, state.sessionId);
          if (!state.queued && state.attempts === 0 && this.keys.get(key) === state)
            this.keys.delete(key);
        }
      })(),
    );
  }

  /** Drops dedupe keys older than the retention window. */
  private forgetDedupeKeys(now: number): void {
    for (const [dedupe, seenAt] of this.seen) {
      if (now - seenAt < this.dedupeRetentionMs) break;
      this.seen.delete(dedupe);
    }
  }

  private async advanceOnce(
    state: KeyState,
    handlers: WorkerHandlers,
  ): Promise<void> {
    const controller = new AbortController();
    state.controller = controller;
    try {
      const result = await handlers.advance(
        state.tenantId,
        state.sessionId,
        controller.signal,
      );
      state.attempts = 0;
      if (result.status === "busy")
        this.later(result.retryAfterMs, () =>
          this.enqueue(state.tenantId, state.sessionId),
        );
    } catch (error) {
      state.attempts += 1;
      if (state.attempts >= this.maxAttempts || controller.signal.aborted) {
        state.attempts = 0;
        this.onError(error);
      } else
        this.later(this.retryDelayMs * 2 ** (state.attempts - 1), () =>
          this.enqueue(state.tenantId, state.sessionId),
        );
    } finally {
      state.controller = undefined;
    }
  }

  private armTimer(id: string, timer: PendingTimer): void {
    timer.handle = setTimeout(
      () => {
        if (this.timers.get(id) !== timer) return;
        this.timers.delete(id);
        const handlers = this.handlers;
        if (!handlers) return;
        if (!handlers.fire) {
          this.onError(new Error("WorkerHandlers.fire is required for timers"));
          return;
        }
        this.track(
          handlers.fire(timer.tenantId, timer.key).catch(this.onError),
        );
      },
      Math.max(0, timer.at - Date.now()),
    );
  }

  private scheduleSweep(tenantId: string, sweep: Sweep, delay: number): void {
    if (sweep.running || sweep.handle) return;
    sweep.handle = setTimeout(() => {
      sweep.handle = undefined;
      const handlers = this.handlers;
      if (!handlers || this.sweeps.get(tenantId) !== sweep) return;
      sweep.running = true;
      this.track(
        handlers
          .sweep(tenantId)
          .catch(this.onError)
          .finally(() => {
            sweep.running = false;
            if (this.handlers && this.sweeps.get(tenantId) === sweep)
              this.scheduleSweep(tenantId, sweep, this.sweepIntervalMs);
          }),
      );
    }, delay);
  }

  private later(ms: number, fn: () => void): void {
    const handle = setTimeout(() => {
      this.delayed.delete(handle);
      fn();
    }, Math.max(0, ms));
    this.delayed.add(handle);
  }

  private track(promise: Promise<void>): void {
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
  }
}
