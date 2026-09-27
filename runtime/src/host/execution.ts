/**
 * The Host's Durable Session Execution (architecture §6, §12.3, §14.8): one per process,
 * shared by every Tenant the Host opens.
 *
 * - `tenantExecution` is what the Host passes to each Tenant it opens
 *   (`TenantOpenHooks.execution`): the execution, the `TenantWorkers` registry its handlers
 *   dispatch through (with `resolve` opening a Tenant on demand when an invocation arrives for
 *   one that is not open), and the Tenant status hook for stuck invocations.
 * - `start` serves the Worker endpoint for `--role worker|all` (`infra/workers.ts`) and does
 *   nothing for `api`, whose wakes, timers and sweep arming go through Restate's ingress.
 * - `armAll` re-arms every Tenant's sweep at startup. Arming is idempotent, so it is safe on
 *   every start, and it is what recovers from lost Restate state: the sweep re-wakes `runnable`
 *   sessions without a live owner (§14.8).
 * - `disarm` stops a deleted Tenant's sweep.
 *
 * **One Worker URL.** `start` registers the Worker endpoint (`NYLORUN_WORKER_URL`) with
 * Restate once. Restate sends new invocations to the latest registered deployment, so
 * several Workers that each register their own URL do not share load: the last one to start
 * takes every new invocation. The V1 stack runs a single `runtime` container with
 * `--role all`. A deployment with several Worker processes (Helm, Cloud) must advertise one
 * load-balanced `NYLORUN_WORKER_URL` shared by all of them.
 */
import type { DurableExecution } from "../execution/types.js";
import { startWorker, stopWorker, type WorkerHandle } from "../infra/workers.js";
import type { Logger } from "../tenant/types.js";
import {
  TenantWorkers,
  type TenantExecution,
  type TenantWorker,
} from "../tenant/worker.js";
import type { RuntimeRole } from "./stack-config.js";

export interface CreateHostExecutionOptions {
  execution: DurableExecution;
  role: RuntimeRole;
  /** Finds or opens a Tenant an invocation arrived for that is not open on this process. */
  resolve: (tenantId: string) => Promise<TenantWorker | undefined>;
  logger?: Logger;
  /**
   * How long one advance may run before its signal aborts and it settles
   * (`tenant/worker.ts`). Default 50 minutes, below Restate's timeouts.
   */
  advanceDeadlineMs?: number;
  /** How long an aborted advance has to return before it is abandoned. Default 30 s. */
  advanceGraceMs?: number;
}

export interface HostExecution {
  /** Pass to every Tenant the Host opens (`TenantOpenHooks.execution`). */
  readonly tenantExecution: TenantExecution;
  /** Serves the Worker endpoint for the worker and all roles. Idempotent. */
  start(): Promise<void>;
  /** Stops serving: aborts running advances and waits for them. Idempotent. */
  stop(): Promise<void>;
  /**
   * Arms every listed Tenant's sweep (idempotent). Tries them all; rejects with an
   * `AggregateError` of the failures after logging each.
   */
  armAll(tenantIds: readonly string[]): Promise<void>;
  /** Stops re-arming a deleted Tenant's sweep. */
  disarm(tenantId: string): Promise<void>;
}

/** How many sweep arms `armAll` sends at once. */
const ARM_CONCURRENCY = 16;

export function createHostExecution(
  options: CreateHostExecutionOptions
): HostExecution {
  const { execution, role, logger } = options;
  const workers = new TenantWorkers({
    resolve: options.resolve,
    ...(options.advanceDeadlineMs !== undefined
      ? { advanceDeadlineMs: options.advanceDeadlineMs }
      : {}),
    ...(options.advanceGraceMs !== undefined
      ? { advanceGraceMs: options.advanceGraceMs }
      : {}),
    ...(logger ? { logger } : {}),
  });
  const tenantExecution: TenantExecution = {
    execution,
    workers,
    ...(execution.stuckInvocations
      ? {
          stuckInvocations: (tenantId: string) =>
            execution.stuckInvocations!(tenantId),
        }
      : {}),
  };
  let started: Promise<WorkerHandle> | undefined;

  return {
    tenantExecution,
    async start() {
      started ??= startWorker({ role, execution, handlers: workers.handlers });
      try {
        await started;
      } catch (error) {
        started = undefined;
        throw error;
      }
    },
    async stop() {
      const handle = await started?.catch(() => undefined);
      if (handle) await stopWorker(handle);
    },
    async armAll(tenantIds) {
      const queue = [...new Set(tenantIds)];
      const failures: unknown[] = [];
      const next = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            await execution.armSweep(id);
          } catch (error) {
            failures.push(error);
            logger?.warn("tenant sweep arm failed", {
              tenantId: id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(ARM_CONCURRENCY, queue.length) }, next)
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `Arming ${failures.length} Tenant sweep(s) failed`
        );
    },
    async disarm(tenantId) {
      await execution.disarmSweep(tenantId);
    },
  };
}
