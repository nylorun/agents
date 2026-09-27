/**
 * Builds the Host's Durable Session Execution from the stack configuration
 * (architecture §6, §12.3, §14.5).
 *
 * With `NYLORUN_RESTATE_INGRESS_URL` and `NYLORUN_RESTATE_ADMIN_URL` the Host
 * uses Restate:
 *
 * - wakes, timers and sweep arming go through the ingress, so every role can
 *   call them;
 * - a Worker (`--role worker|all`) serves the Restate endpoint on
 *   `0.0.0.0:9080` and registers `NYLORUN_WORKER_URL` with the admin API when
 *   `infra/workers.ts` starts it;
 * - with `NYLORUN_RESTATE_IDENTITY_KEY` the endpoint accepts only requests
 *   signed by the Restate server holding the matching private key.
 *
 * Without Restate endpoints it returns the in-process memory execution, which
 * only unit tests and a local development Host use.
 */
import { createRestateExecution } from "../adapters/execution/restate.js";
import { MemoryExecution } from "../execution/memory.js";
import type { DurableExecution } from "../execution/types.js";
import type { RuntimeRole, StackConfig } from "../host/stack-config.js";

/** Where a Worker serves the Restate endpoint (architecture §14.3). */
export const WORKER_LISTEN = { host: "0.0.0.0", port: 9080 } as const;

export interface CreateExecutionOptions {
  /**
   * Prepended to Restate service names, so several Runtimes or test runs can
   * share one Restate server. Letters, digits and `_`. Default "".
   */
  servicePrefix?: string;
  /** Replaces `WORKER_LISTEN` (tests serving several Workers on one machine). */
  workerListen?: { host: string; port: number };
  /** Receives the Restate SDK's log lines instead of the console. */
  logger?: (level: string, message: string) => void;
}

/** Which implementation `createExecution` chooses for a configuration. */
export function executionKind(
  config: Pick<StackConfig, "endpoints">,
): "restate" | "memory" {
  const { restateIngressUrl, restateAdminUrl } = config.endpoints;
  return restateIngressUrl || restateAdminUrl ? "restate" : "memory";
}

/**
 * Throws naming the missing variable when the Restate endpoints are
 * incomplete for `role`. The api role never serves the Worker endpoint, so it
 * needs no `NYLORUN_WORKER_URL`.
 */
export function validateExecutionConfig(
  config: Pick<StackConfig, "endpoints"> & { role?: RuntimeRole },
): void {
  const { restateIngressUrl, restateAdminUrl, workerUrl, restateIdentityKeys } =
    config.endpoints;
  if (executionKind(config) === "memory") {
    if (workerUrl || restateIdentityKeys?.length)
      throw new Error(
        `${workerUrl ? "NYLORUN_WORKER_URL" : "NYLORUN_RESTATE_IDENTITY_KEY"} is set without the Restate endpoints; set NYLORUN_RESTATE_INGRESS_URL and NYLORUN_RESTATE_ADMIN_URL`,
      );
    return;
  }
  if (!restateIngressUrl)
    throw new Error("NYLORUN_RESTATE_INGRESS_URL is required with NYLORUN_RESTATE_ADMIN_URL");
  if (!restateAdminUrl)
    throw new Error("NYLORUN_RESTATE_ADMIN_URL is required with NYLORUN_RESTATE_INGRESS_URL");
  if ((config.role ?? "all") !== "api" && !workerUrl)
    throw new Error(
      `NYLORUN_WORKER_URL is required for --role ${config.role ?? "all"}: the Worker endpoint URL Restate calls`,
    );
}

export function createExecution(
  config: Pick<StackConfig, "endpoints"> & { role?: RuntimeRole },
  options: CreateExecutionOptions = {},
): DurableExecution {
  validateExecutionConfig(config);
  const { restateIngressUrl, restateAdminUrl, workerUrl, restateIdentityKeys } =
    config.endpoints;
  if (!restateIngressUrl || !restateAdminUrl) return new MemoryExecution();
  return createRestateExecution({
    ingressUrl: restateIngressUrl,
    adminUrl: restateAdminUrl,
    workerListen: options.workerListen ?? { ...WORKER_LISTEN },
    ...(workerUrl ? { workerAdvertisedUrl: workerUrl } : {}),
    ...(restateIdentityKeys?.length ? { identityKeys: [...restateIdentityKeys] } : {}),
    ...(options.servicePrefix ? { servicePrefix: options.servicePrefix } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/**
 * Readiness probe: resolves when Restate's admin API and ingress answer
 * within `signal`'s lifetime. The memory execution is always ready.
 */
export async function probeExecution(
  execution: DurableExecution,
  signal: AbortSignal,
): Promise<void> {
  await execution.probe?.(signal);
}
