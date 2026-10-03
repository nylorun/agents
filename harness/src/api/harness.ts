/**
 * A harness: one long-running client of the Harness API that leases runs and runs them. It says
 * `hello`, then always keeps one `lease` request waiting while it has room. Each run gets its
 * own abort controller: core's `cancel` aborts it with core's reason, a renewal core refuses
 * with `ownership.lost`, and `stop()` with `shutdown`. While a run is live it renews its lease
 * every `renewEveryMs`; renewing stops once the run is aborted.
 */
import {
  HARNESS_API_VERSION,
  type AbortReason,
  type HarnessChannel,
  type RunGrant,
} from "@nylorun/core/harness-api";
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
    if (method !== "cancel") return;
    const { runId, reason, message } = params as {
      runId: string;
      reason: AbortReason;
      message?: string;
    };
    const run = live.get(runId);
    if (run) abort(run, reason, message);
  });
  channel.onClose(() => {
    for (const run of live.values()) abort(run, "shutdown", "The Harness API connection closed");
  });

  const renew = (run: Live) => {
    const timer = setInterval(() => {
      if (run.controller.signal.aborted) return clearInterval(timer);
      channel.request("lease.renew", { runId: run.runId }).then(
        (answer) => {
          if (!answer.ok) abort(run, "ownership.lost");
          else if (answer.token)
            run.grant = {
              ...run.grant,
              token: answer.token,
              tokenExpiresAt: answer.tokenExpiresAt,
            };
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
    const run: Live = { runId: grant.runId, grant, start, controller, signal: controller.signal };
    live.set(run.runId, run);
    const stopRenewing = renew(run);
    const done = runTurn({ channel, executors, cache }, run)
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
        capabilities: {},
      });
      renewEveryMs = hello.renewEveryMs;
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
