import {
  DEFAULT_STOP_GRACE_MS,
  WAKE_REASONS,
  sessionKey,
  settleWithin,
  type DurableExecution,
  type SandboxSignal,
  type SandboxTrigger,
  type Wake,
  type WorkerHandlers,
} from "./types.js";

export interface MemoryExecutionOptions {
  /** Delay between sweep passes of one Tenant. Default 5000. */
  sweepIntervalMs?: number;
  /** First retry delay after `advance` throws; doubles per attempt. Default 50. */
  retryDelayMs?: number;
  /** Attempts before giving up on a throwing handler and reporting it. Default 5. */
  maxAttempts?: number;
  /** How long a dedupe key merges repeated wakes. Default 24 hours. */
  dedupeRetentionMs?: number;
  /**
   * How long `stop` waits for running handlers after aborting them; the ones still running
   * then are abandoned. Default `DEFAULT_STOP_GRACE_MS`.
   */
  stopGraceMs?: number;
  /** Receives handler failures that are not retried. */
  onError?: (error: unknown) => void;
}

/** One session's advances. */
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

/** A pod sandbox's reconciles (one at a time) and timers (F7.2). */
interface SandboxState {
  tenantId: string;
  sandboxId: string;
  tail: Promise<void>;
  /** Pending runs not yet on the tail (before `start`). */
  pending: SandboxTrigger[];
  attempts: number;
  /** `idle`, `ttl` and the reconcile's own `retry`; a later time replaces an earlier one. */
  timers: Map<"idle" | "ttl" | "retry", { at: number; handle?: NodeJS.Timeout }>;
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
  private readonly sandboxes = new Map<string, SandboxState>();
  private readonly delayed = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly sweepIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly dedupeRetentionMs: number;
  private readonly stopGraceMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(options: MemoryExecutionOptions = {}) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.dedupeRetentionMs = options.dedupeRetentionMs ?? 24 * 60 * 60_000;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
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

  async sandbox(tenantId: string, sandboxId: string, signal: SandboxSignal): Promise<void> {
    const key = `${tenantId}\u0000${sandboxId}`;
    let state = this.sandboxes.get(key);
    if (!state)
      this.sandboxes.set(
        key,
        (state = { tenantId, sandboxId, tail: Promise.resolve(), pending: [], attempts: 0, timers: new Map() }),
      );
    if (signal.kind === "arm") this.armSandbox(state, signal.timer, signal.at);
    else this.runSandbox(state, "reconcile");
  }

  private armSandbox(state: SandboxState, timer: "idle" | "ttl" | "retry", at: number): void {
    const existing = state.timers.get(timer);
    if (existing?.handle) clearTimeout(existing.handle);
    const entry: { at: number; handle?: NodeJS.Timeout } = { at };
    state.timers.set(timer, entry);
    if (!this.handlers) return;
    entry.handle = setTimeout(
      () => {
        if (state.timers.get(timer) !== entry) return;
        state.timers.delete(timer);
        this.runSandbox(state, timer === "retry" ? "reconcile" : timer);
      },
      Math.max(0, at - Date.now()),
    );
  }

  private runSandbox(state: SandboxState, trigger: SandboxTrigger): void {
    const handlers = this.handlers;
    if (!handlers) {
      state.pending.push(trigger);
      return;
    }
    const run = state.tail.then(async () => {
      if (!this.handlers) return;
      if (!handlers.sandbox) {
        this.onError(new Error("WorkerHandlers.sandbox is required for sandbox reconciles"));
        return;
      }
      const controller = new AbortController();
      try {
        const result = await handlers.sandbox(state.tenantId, state.sandboxId, trigger, controller.signal);
        state.attempts = 0;
        for (const item of result.arm ?? []) this.armSandbox(state, item.timer, item.at);
        if (result.retryAfterMs !== undefined)
          this.armSandbox(state, "retry", Date.now() + Math.max(0, result.retryAfterMs));
      } catch (error) {
        state.attempts += 1;
        if (state.attempts >= this.maxAttempts) {
          state.attempts = 0;
          this.onError(error);
        } else
          this.armSandbox(state, "retry", Date.now() + this.retryDelayMs * 2 ** (state.attempts - 1));
      }
    });
    state.tail = run.catch(() => undefined);
    this.track(state.tail);
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
    for (const state of this.sandboxes.values()) {
      for (const [timer, entry] of state.timers) this.armSandbox(state, timer, entry.at);
      for (const trigger of state.pending.splice(0)) this.runSandbox(state, trigger);
    }
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    for (const handle of this.delayed) clearTimeout(handle);
    this.delayed.clear();
    for (const timer of this.timers.values())
      if (timer.handle) clearTimeout(timer.handle);
    for (const sweep of this.sweeps.values())
      if (sweep.handle) clearTimeout(sweep.handle);
    for (const state of this.sandboxes.values())
      for (const entry of state.timers.values()) if (entry.handle) clearTimeout(entry.handle);
    for (const state of this.keys.values()) state.controller?.abort();
    // Bounded: a handler that ignores its abort is abandoned and runs on unwaited. An
    // abandoned advance's lease lapses and the next advance takes the session over (§11.4).
    await settleWithin(this.inflight, this.stopGraceMs);
  }

  /**
   * Resolves once no advance is running or queued and no busy or retry re-run is
   * pending. Timers and sweeps are not waited for. Test helper.
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
            await this.runOnce(state, this.handlers);
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

  private async runOnce(
    state: KeyState,
    handlers: WorkerHandlers,
  ): Promise<void> {
    const controller = new AbortController();
    state.controller = controller;
    const again = () => this.enqueue(state.tenantId, state.sessionId);
    try {
      const retryAfterMs = await this.call(state, handlers, controller.signal);
      state.attempts = 0;
      if (retryAfterMs !== undefined) this.later(retryAfterMs, again);
    } catch (error) {
      state.attempts += 1;
      if (state.attempts >= this.maxAttempts || controller.signal.aborted) {
        state.attempts = 0;
        this.onError(error);
      } else this.later(this.retryDelayMs * 2 ** (state.attempts - 1), again);
    } finally {
      state.controller = undefined;
    }
  }

  /** Runs the session's advance; resolves to a delay when it must run again. */
  private async call(
    state: KeyState,
    handlers: WorkerHandlers,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const result = await handlers.advance(state.tenantId, state.sessionId, signal);
    return result.status === "busy" ? result.retryAfterMs : undefined;
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

