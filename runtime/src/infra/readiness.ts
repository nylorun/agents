/**
 * Aggregate readiness of the Host's infrastructure (architecture §13, §14.3):
 * the Runtime's `/ready` covers Postgres, Restate and S2. s2-lite's image has
 * no health check of its own, so this is the only place its health shows.
 *
 * Every probe runs on each call, in parallel, bounded by one timeout. A probe
 * that throws or outlives the timeout marks its check `false`. Only check
 * names and booleans are reported; the errors stay in the report for logs.
 */
import type { DurableExecution } from "../execution/types.js";
import type { DurableStreams } from "../streams/types.js";
import { probeDatabase, type PostgresClient } from "./database.js";
import { probeExecution } from "./execution.js";
import { probeStreams } from "./streams.js";

/** Resolves when the dependency answers; rejects otherwise. Must honour `signal`. */
export type Probe = (signal: AbortSignal) => Promise<void>;

export interface ReadinessReport {
  ok: boolean;
  /** One entry per configured dependency, e.g. `{ postgres, restate, s2 }`. */
  checks: Record<string, boolean>;
  /** Why each failing check failed. Not for unauthenticated responses. */
  errors: Record<string, string>;
}

export type Readiness = () => Promise<ReadinessReport>;

/** Default bound on one readiness pass. Compose probes `/ready` every 2 s with a 5 s timeout. */
export const READINESS_TIMEOUT_MS = 2000;

export function createReadiness(
  probes: Readonly<Record<string, Probe>>,
  options: { timeoutMs?: number } = {},
): Readiness {
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  return async () => {
    const entries = Object.entries(probes);
    const results = await Promise.all(
      entries.map(async ([name, probe]) => [name, await runProbe(probe, timeoutMs)] as const),
    );
    const checks: Record<string, boolean> = {};
    const errors: Record<string, string> = {};
    for (const [name, error] of results) {
      checks[name] = error === undefined;
      if (error !== undefined) errors[name] = error;
    }
    return { ok: Object.values(checks).every(Boolean), checks, errors };
  };
}

/** The standard checks for whichever infrastructure the Host was built with. */
export function infraProbes(infra: {
  database?: PostgresClient;
  execution?: DurableExecution;
  streams?: DurableStreams;
}): Record<string, Probe> {
  const probes: Record<string, Probe> = {};
  const { database, execution, streams } = infra;
  if (database) probes.postgres = (signal) => probeDatabase(database, signal);
  if (execution) probes.restate = (signal) => probeExecution(execution, signal);
  if (streams) probes.s2 = (signal) => probeStreams(streams, signal);
  return probes;
}

/** Runs one probe under a timeout; returns its failure message, or undefined when ready. */
async function runProbe(probe: Probe, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`timed out after ${timeoutMs} ms`));
      resolve(`timed out after ${timeoutMs} ms`);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      probe(controller.signal).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort(new Error("readiness pass finished"));
  }
}
