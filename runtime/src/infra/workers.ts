/**
 * Worker lifecycle by role (architecture §6).
 *
 * | Role | Serves | `execution.start` |
 * | --- | --- | --- |
 * | `api` | Tenant API, Admin API, SSE | **never**: wakes, timers and sweep arming go through Restate's ingress, which needs no Worker endpoint |
 * | `worker` | the Restate endpoint (`NylorunSession.advance`, `NylorunTenant.sweep`, timers) | yes |
 * | `all` | both (the local stack) | yes |
 *
 * An API node that called `start` would register its own endpoint with
 * Restate, and Restate would send new invocations to it (it routes to the
 * latest registered deployment), so the rule is enforced here rather than left
 * to callers: `startWorker` with role `api` returns a handle that never
 * started anything.
 */
import type { DurableExecution, WorkerHandlers } from "../execution/types.js";
import type { RuntimeRole } from "../host/stack-config.js";

export interface WorkerHandle {
  readonly role: RuntimeRole;
  /** True when this process serves the Worker endpoint. */
  readonly serving: boolean;
}

/** Whether a process in `role` serves the Worker endpoint. */
export function servesWorker(role: RuntimeRole): boolean {
  return role !== "api";
}

/** What `stopWorker` needs for a handle that serves the endpoint. */
const started = new WeakMap<
  WorkerHandle,
  { execution: DurableExecution; stopped?: Promise<void> }
>();

/**
 * Starts delivering Restate invocations to `handlers` when `role` is `worker`
 * or `all` (serving and registering the Worker endpoint, for Restate). For
 * `api` it does nothing. Rejects if the endpoint cannot listen or register.
 */
export async function startWorker(input: {
  role: RuntimeRole;
  execution: DurableExecution;
  handlers: WorkerHandlers;
}): Promise<WorkerHandle> {
  const { role, execution, handlers } = input;
  const handle: WorkerHandle = Object.freeze({ role, serving: servesWorker(role) });
  if (!handle.serving) return handle;
  await execution.start(handlers);
  started.set(handle, { execution });
  return handle;
}

/**
 * Stops a Worker started by `startWorker`: aborts running advances' signals
 * and waits for them. Idempotent; a no-op for the api role.
 */
export async function stopWorker(handle: WorkerHandle): Promise<void> {
  const worker = started.get(handle);
  if (!worker) return;
  worker.stopped ??= worker.execution.stop();
  await worker.stopped;
}
