/**
 * A harness: one long-running client of the Harness API that leases runs and runs them. It says
 * `hello`, then always keeps one `lease` request waiting while it has room. Each run gets its
 * own abort controller: core's `cancel` aborts it with core's reason, a renewal core refuses
 * with `ownership.lost`, and `stop()` with `shutdown`. While a run is live it renews its lease
 * every `renewEveryMs`; renewing stops once the run is aborted.
 *
 * A run whose Action is pending is held (F6.2): it waits up to `holdMs` for core's
 * `effect.resolved` and goes on in the same lease, instead of ending the segment and being
 * replayed by the next one.
 */
import {
  HARNESS_API_VERSION,
  type AbortReason,
  type HarnessChannel,
  type ResultOf,
  type RunGrant,
} from "@nylorun/core/harness-api";
import type { ActionOutcome } from "@nylorun/core/contracts";
import { ABORT_MESSAGES, RunAbort } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";
import { runTurn } from "./run.js";
import { TranscriptCache } from "./transcript-cache.js";

export interface HarnessLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface HarnessOptions {
  readonly channel: HarnessChannel;
  readonly executors: HarnessExecutors;
  readonly logger?: HarnessLogger;
  /** Runs held at once. Default: no limit. */
  readonly maxRuns?: number;
  /** Byte budget of the transcript cache. Default 256 MiB. */
  readonly transcriptCacheMb?: number;
  readonly name?: string;
  readonly version?: string;
  /** What `hello` declares: `workspace` when this harness serves the Tenant's workspaces. */
  readonly capabilities?: { readonly workspace?: unknown };
  /** Sees core's answer to `hello` (the Tenant, the sandbox backend preference). */
  onHello?(answer: ResultOf<"hello">): void;
  /** Sees every grant a run gets: when it is leased, and each renewal with a new run token. */
  onGrant?(grant: RunGrant): void;
  /**
   * The longest a run waits for a pending Action's outcome before its segment ends as waiting:
   * core says how long each run may (`TurnStart.options.holdMs`), never past the segment's
   * yield budget. Default: as long as core says.
   */
  readonly holdMs?: number;
}

export interface Harness {
  /** Says `hello` and starts leasing. Resolves once `hello` is answered. */
  start(): Promise<void>;
  /**
   * Stops leasing, aborts the runs with `shutdown`, and waits for them to give their leases
   * back, at most `waitMs` (default: as long as they take). A run that ignores its abort is
   * left behind: its lease lapses.
   */
  stop(waitMs?: number): Promise<void>;
  /** Runs held now. */
  readonly runs: number;
}

interface Live extends HarnessRun {
  grant: RunGrant;
  readonly controller: AbortController;
  /** Outcomes core sent for this run's pending Actions (`effect.resolved`), until taken. */
  readonly resolved: Map<string, ActionOutcome>;
  /** Waiters for one of those outcomes, by effect id. */
  readonly waiting: Map<string, (outcome: ActionOutcome) => void>;
}

export function createHarness(options: HarnessOptions): Harness {
  const { channel, executors } = options;
  const maxRuns = options.maxRuns ?? Infinity;
  const cache = new TranscriptCache((options.transcriptCacheMb ?? 256) * 1024 * 1024);
  const live = new Map<string, Live>();
  const finished = new Set<Promise<void>>();
  const leasing = new AbortController();
  let renewEveryMs = 10_000;
  let stopped = false;
  let waiting = false;

  const abort = (run: Live, kind: AbortReason, message?: string) => {
    if (!run.controller.signal.aborted)
      run.controller.abort(new RunAbort(kind, message ?? ABORT_MESSAGES[kind]));
  };

  channel.listen((method, params) => {
    if (method === "effect.resolved") {
      const { runId, effectId, outcome } = params as {
        runId: string;
        effectId: string;
        outcome: ActionOutcome;
      };
      const run = live.get(runId);
      if (!run) return;
      const waiter = run.waiting.get(effectId);
      if (waiter) waiter(outcome);
      else run.resolved.set(effectId, outcome);
      return;
    }
    if (method !== "cancel") return;
    const { runId, reason, message } = params as {
      runId: string;
      reason: AbortReason;
      message?: string;
    };
    const run = live.get(runId);
    if (run) abort(run, reason, message);
  });

  /** Waits for core's outcome of a pending Action of `run`, at most `ms`, or until it aborts. */
  const hold = (held: HarnessRun, effectId: string, ms: number) => {
    const run = live.get(held.runId);
    // Core may stop the run while it asks about the Action (a cancel, or a shutdown on close):
    // its abort fired already, so a listener added now would never run, and the run would
    // keep its lease for the whole hold.
    if (!run || ms <= 0 || run.signal.aborted) return Promise.resolve(undefined);
    const known = run.resolved.get(effectId);
    if (known) {
      run.resolved.delete(effectId);
      return Promise.resolve(known);
    }
    return new Promise<ActionOutcome | undefined>((resolve) => {
      const done = (outcome: ActionOutcome | undefined) => {
        clearTimeout(timer);
        run.waiting.delete(effectId);
        run.signal.removeEventListener("abort", aborted);
        resolve(outcome);
      };
      const aborted = () => done(undefined);
      const timer = setTimeout(() => done(undefined), ms);
      timer.unref?.();
      run.waiting.set(effectId, done);
      run.signal.addEventListener("abort", aborted, { once: true });
    });
  };
  channel.onClose(() => {
    for (const run of live.values()) abort(run, "shutdown", "The Harness API connection closed");
  });

  const renew = (run: Live) => {
    const timer = setInterval(() => {
      if (run.controller.signal.aborted) return clearInterval(timer);
      channel.request("lease.renew", { runId: run.runId }).then(
        (answer) => {
          if (!answer.ok) abort(run, "ownership.lost");
          else if (answer.token && answer.token !== run.grant.token) {
            run.grant = {
              ...run.grant,
              token: answer.token,
              tokenExpiresAt: answer.tokenExpiresAt,
            };
            options.onGrant?.(run.grant);
          }
        },
        (error: unknown) => {
          if (!run.controller.signal.aborted)
            options.logger?.warn("harness lease renewal failed", {
              runId: run.runId,
              message: error instanceof Error ? error.message : String(error),
            });
        },
      );
    }, renewEveryMs);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  const begin = (grant: RunGrant, start: HarnessRun["start"]) => {
    const controller = new AbortController();
    const run: Live = {
      runId: grant.runId,
      grant,
      start,
      controller,
      signal: controller.signal,
      resolved: new Map(),
      waiting: new Map(),
    };
    live.set(run.runId, run);
    options.onGrant?.(grant);
    const stopRenewing = renew(run);
    const done = runTurn(
      {
        channel,
        executors,
        cache,
        hold,
        ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
      },
      run,
    )
      .catch((error: unknown) =>
        options.logger?.warn("harness run failed", {
          runId: run.runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        stopRenewing();
        live.delete(run.runId);
        finished.delete(done);
        lease();
      });
    finished.add(done);
  };

  const lease = () => {
    if (stopped || waiting || channel.closed || live.size >= maxRuns) return;
    waiting = true;
    channel.request("lease", {}, leasing.signal).then(
      ({ run, input }) => {
        waiting = false;
        begin(run, input);
        lease();
      },
      (error: unknown) => {
        waiting = false;
        if (stopped || channel.closed) return;
        options.logger?.warn("harness lease failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        setTimeout(lease, 100).unref?.();
      },
    );
  };

  return {
    get runs() {
      return live.size;
    },
    async start() {
      const hello = await channel.request("hello", {
        api: HARNESS_API_VERSION,
        name: options.name ?? "@nylorun/harness",
        version: options.version ?? "0",
        capabilities:
          options.capabilities?.workspace === undefined
            ? {}
            : { workspace: options.capabilities.workspace },
      });
      renewEveryMs = hello.renewEveryMs;
      options.onHello?.(hello);
      lease();
    },
    async stop(waitMs = Infinity) {
      stopped = true;
      leasing.abort(new RunAbort("shutdown", ABORT_MESSAGES.shutdown));
      for (const run of live.values()) abort(run, "shutdown");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...finished]),
        ...(Number.isFinite(waitMs)
          ? [new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]
          : []),
      ]);
      clearTimeout(timer);
    },
  };
}
