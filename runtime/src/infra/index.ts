/**
 * The Host's infrastructure clients, built from the stack configuration: the
 * Postgres pool, Durable Session Execution and Durable Streams, each only when
 * its endpoints are configured, plus the readiness that covers them.
 *
 * Building a client connects to nothing: the pool connects on first query,
 * Restate and S2 on first call. Nothing here starts a Worker (see
 * `workers.ts`).
 */
import type { DurableExecution } from "../execution/types.js";
import type { StackConfig } from "../host/stack-config.js";
import type { DurableStreams } from "../streams/types.js";
import type { Logger } from "../tenant/types.js";
import { createDatabase, type PostgresClient } from "./database.js";
import { createExecution, executionKind, type CreateExecutionOptions } from "./execution.js";
import { createReadiness, infraProbes, type Readiness } from "./readiness.js";
import { createStreams, streamsKind, type CreateStreamsOptions } from "./streams.js";

export { createDatabase, probeDatabase } from "./database.js";
export { createExecution, probeExecution, WORKER_LISTEN } from "./execution.js";
export { createReadiness, infraProbes } from "./readiness.js";
export type { Probe, Readiness, ReadinessReport } from "./readiness.js";
export { createStreams, probeStreams } from "./streams.js";
export { servesWorker, startWorker, stopWorker } from "./workers.js";
export type { WorkerHandle } from "./workers.js";

export interface Infra {
  database?: PostgresClient;
  execution?: DurableExecution;
  streams?: DurableStreams;
  /** Present when at least one client was built. */
  readiness?: Readiness;
  /** Ends the pool and closes the streams. Does not stop a Worker. */
  close(): Promise<void>;
}

/**
 * Builds the configured clients. Throws naming the variable when endpoints are
 * incomplete (e.g. a Restate ingress without an admin URL).
 */
export function createInfra(
  config: Pick<StackConfig, "role" | "endpoints">,
  options: {
    logger?: Logger;
    execution?: CreateExecutionOptions;
    streams?: CreateStreamsOptions;
  } = {},
): Infra {
  const database = config.endpoints.databaseUrl ? createDatabase(config) : undefined;
  const execution =
    executionKind(config) === "restate"
      ? createExecution(config, options.execution)
      : undefined;
  const streams =
    streamsKind(config) === "s2" ? createStreams(config, options.streams) : undefined;
  const probes = infraProbes({
    ...(database ? { database } : {}),
    ...(execution ? { execution } : {}),
    ...(streams ? { streams } : {}),
  });
  const readiness =
    Object.keys(probes).length > 0
      ? logTransitions(createReadiness(probes), options.logger)
      : undefined;
  return {
    ...(database ? { database } : {}),
    ...(execution ? { execution } : {}),
    ...(streams ? { streams } : {}),
    ...(readiness ? { readiness } : {}),
    async close() {
      await Promise.allSettled([database?.end({ timeout: 5 }), streams?.close()]);
    },
  };
}

/** Logs a check when it starts failing and when it recovers, not on every probe. */
function logTransitions(readiness: Readiness, logger: Logger | undefined): Readiness {
  if (!logger) return readiness;
  const failing = new Set<string>();
  return async () => {
    const report = await readiness();
    for (const [name, ok] of Object.entries(report.checks)) {
      if (!ok && !failing.has(name)) {
        failing.add(name);
        logger.warn("ready_check_failed", { check: name, error: report.errors[name] });
      } else if (ok && failing.delete(name)) {
        logger.info("ready_check_recovered", { check: name });
      }
    }
    return report;
  };
}
