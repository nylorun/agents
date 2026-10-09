/**
 * Builds the Host's Durable Session Execution from the stack configuration
 * (architecture §6, §12.3, §14.5).
 *
 * With `NYLORUN_RESTATE_INGRESS_URL` and `NYLORUN_RESTATE_ADMIN_URL` the Host
 * uses Restate:
 *
 * - wakes, timers and sweep arming go through the ingress, so every process can
 *   call them;
 * - a Worker (a process running the loop service) serves the Restate endpoint on
 *   `0.0.0.0:9080` and registers it with the admin API when `infra/workers.ts` starts it,
 *   as a versioned deployment (`workerDeployment`);
 * - with `NYLORUN_RESTATE_IDENTITY_KEY` the endpoint accepts only requests
 *   signed by the Restate server holding the matching private key.
 *
 * Without Restate endpoints it returns the in-process memory execution, which
 * only unit tests and a local development Host use.
 */
import { createRestateExecution } from "../adapters/execution/restate.js";
import { RUNTIME_VERSION } from "../version.js";
import { MemoryExecution } from "../execution/memory.js";
import type { DurableExecution } from "../execution/types.js";
import {
  DEFAULT_SERVICES,
  describeServices,
  type RuntimeServices,
  type StackConfig,
} from "../host/stack-config.js";

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
 * incomplete for `services`. Without the loop service a process never serves
 * the Worker endpoint, so it needs no `NYLORUN_WORKER_URL`.
 */
export function validateExecutionConfig(
  config: Pick<StackConfig, "endpoints"> & { services?: RuntimeServices },
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
  const services = config.services ?? DEFAULT_SERVICES;
  if (services.has("loop") && !workerUrl)
    throw new Error(
      `NYLORUN_WORKER_URL is required for --service ${describeServices(services)}: the Worker endpoint URL Restate calls`,
    );
}

/**
 * The deployment a Worker registers with Restate (§14.6): `<NYLORUN_WORKER_URL>/nylorun/<version>`,
 * the version being `NYLORUN_WORKER_VERSION` or the Runtime's. Restate sends new invocations to
 * the latest deployment of a service and keeps each running invocation on the deployment it
 * started on, so during a rolling upgrade the Workers of one version share that version's
 * deployment (behind one load-balanced `NYLORUN_WORKER_URL`) and the old one finishes what it
 * started; the endpoint answers on any path, so an older deployment's URL still reaches it.
 * `force` replaces a deployment already registered at the URL with different code: only
 * outside a container (a development Host, whose code changes under one version). In a
 * container Restate may refuse a registration that conflicts with the deployment there: a
 * build whose code changed under the same version sets its own `NYLORUN_WORKER_VERSION`.
 */
export function workerDeployment(
  config: Pick<StackConfig, "endpoints" | "listen">,
): { url: string; force: boolean } | undefined {
  const { workerUrl, workerVersion } = config.endpoints;
  if (!workerUrl) return undefined;
  const version = encodeURIComponent(workerVersion ?? RUNTIME_VERSION);
  return { url: `${workerUrl.replace(/\/+$/, "")}/nylorun/${version}`, force: !config.listen };
}

export function createExecution(
  config: Pick<StackConfig, "endpoints" | "listen"> & { services?: RuntimeServices },
  options: CreateExecutionOptions = {},
): DurableExecution {
  validateExecutionConfig(config);
  const { restateIngressUrl, restateAdminUrl, restateIdentityKeys } = config.endpoints;
  if (!restateIngressUrl || !restateAdminUrl) return new MemoryExecution();
  const deployment = workerDeployment(config);
  return createRestateExecution({
    ingressUrl: restateIngressUrl,
    adminUrl: restateAdminUrl,
    workerListen: options.workerListen ?? { ...WORKER_LISTEN },
    ...(deployment
      ? { workerAdvertisedUrl: deployment.url, forceRegistration: deployment.force }
      : {}),
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
