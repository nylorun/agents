/**
 * The Worker side of Durable Session Execution (architecture §12.3): what a `DurableExecution`
 * calls for one Tenant, and the registry that lets one execution serve every Tenant open on
 * this process.
 *
 * - `TenantWorker` is one open Tenant's handlers: `advance(sessionId, signal)` (§10.5, in
 *   `advance.ts`) and `sweep()` (the Tenant sweep, in `sweep.ts`).
 * - `TenantWorkers` is the registry. Its `handlers` are the `WorkerHandlers` an execution is
 *   started with; they dispatch by `tenantId` to the registered `TenantWorker`. A Tenant
 *   registers when it opens and unregisters when it closes. A call for a Tenant that is not
 *   open here asks the optional `resolve` hook (the Host can open it on demand); without one,
 *   the advance returns `done` and the sweep does nothing. Nothing is lost: the Tenant's sweep
 *   re-wakes its orphaned sessions once it is open again.
 * - `TenantExecution` pairs an execution with its registry. The Host creates one per process
 *   and passes it to every Tenant it opens; a Tenant opened without one (tests, ephemeral)
 *   gets its own in-process `MemoryExecution`.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  AdvanceResult,
  DurableExecution,
  WorkerHandlers,
} from "../execution/types.js";

/** This process's Worker id: the `owner` it writes on the sessions it advances (§10.6). */
export const WORKER_ID = `worker-${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;

/** One open Tenant's handlers. */
export interface TenantWorker {
  /** Advances one session. Session outcomes never throw; only infrastructure errors do. */
  advance(sessionId: string, signal: AbortSignal): Promise<AdvanceResult>;
  /** One pass of the Tenant sweep. */
  sweep(): Promise<void>;
}

export interface TenantWorkersOptions {
  /** Finds or opens a Tenant that is not registered on this process. */
  resolve?: (tenantId: string) => Promise<TenantWorker | undefined>;
}

/** Registry of open Tenants' workers, dispatched to by `tenantId`. */
export class TenantWorkers {
  private readonly workers = new Map<string, TenantWorker>();

  constructor(private readonly options: TenantWorkersOptions = {}) {}

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
      return worker ? worker.advance(sessionId, signal) : { status: "done" };
    },
    sweep: async (tenantId) => {
      await (await this.find(tenantId))?.sweep();
    },
  };
}

/** A Durable Session Execution together with the registry its handlers dispatch through. */
export interface TenantExecution {
  readonly execution: DurableExecution;
  readonly workers: TenantWorkers;
}
