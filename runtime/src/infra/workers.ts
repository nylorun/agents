/**
 * Worker lifecycle by service (architecture §6, blueprint §19).
 *
 * | Services | Serves | `execution.start` |
 * | --- | --- | --- |
 * | `core` | Tenant API, Admin API, SSE | **never**: wakes, timers and sweep arming go through Restate's ingress, which needs no Worker endpoint |
 * | `loop` | the Restate endpoint (`NylorunSession.advance`, `NylorunTenant.sweep`, timers) | yes |
 * | `core,loop` | both (the local stack's `runtime` container) | yes |
 *
 * A core-only process that called `start` would register its own endpoint with
 * Restate, and Restate would send new invocations to it (it routes to the
 * latest registered deployment), so the rule is enforced here rather than left
 * to callers: `startWorker` without the loop service returns a handle that
 * never started anything.
 */
import type { DurableExecution, WorkerHandlers } from "../execution/types.js";
import type { RuntimeServices } from "../host/stack-config.js";

export interface WorkerHandle {
  readonly services: RuntimeServices;
  /** True when this process serves the Worker endpoint. */
  readonly serving: boolean;
}

/** Whether a process running `services` serves the Worker endpoint: when it runs loop. */
export function servesWorker(services: RuntimeServices): boolean {
  return services.has("loop");
}

/** What `stopWorker` needs for a handle that serves the endpoint. */
const started = new WeakMap<
  WorkerHandle,
  { execution: DurableExecution; stopped?: Promise<void> }
>();

/**
 * Starts delivering Restate invocations to `handlers` when the process runs
 * loop (serving and registering the Worker endpoint, for Restate). Without
 * loop it does nothing. Rejects if the endpoint cannot listen or register.
 */
export async function startWorker(input: {
  services: RuntimeServices;
  execution: DurableExecution;
  handlers: WorkerHandlers;
}): Promise<WorkerHandle> {
  const { services, execution, handlers } = input;
  const handle: WorkerHandle = Object.freeze({ services, serving: servesWorker(services) });
  if (!handle.serving) return handle;
  await execution.start(handlers);
  started.set(handle, { execution });
  return handle;
}

/**
 * Stops a Worker started by `startWorker`: aborts running advances' signals
 * and waits for them. Idempotent; a no-op without the loop service.
 */
export async function stopWorker(handle: WorkerHandle): Promise<void> {
  const worker = started.get(handle);
  if (!worker) return;
  worker.stopped ??= worker.execution.stop();
  await worker.stopped;
}
