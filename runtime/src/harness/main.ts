/**
 * The harness service (`--service harness`, F6.2): the process that runs the Tenant's agent
 * segments, MCP servers and sandboxes, apart from core. It holds one credential, the harness
 * token, for core's Harness API; its model and MCP calls present the run token of the run they
 * belong to (from the `lease` answer and each renewal), never the gates' credential. It opens no
 * database, no Restate, no keys.
 *
 * Its files live under `NYLORUN_HARNESS_ROOT` (`/harness`): `sandboxes/` (workspaces and their
 * records). `/health` answers on 127.0.0.1 only.
 *
 * In a pod sandbox (`NYLORUN_SANDBOX_KIND=pod`, F7.2) it is that sandbox's engine: it first waits
 * until the pod's NetworkPolicy is in force (`awaitNetworkPolicy`), then joins with the
 * pod's join token instead of a harness token (`pod.ts`), and runs its sandbox's tools in the
 * pod itself (the `local` backend), with egress through egress-gate. SIGTERM (tini forwards
 * it; the pod's grace is 10 s by default) gives its runs back and exits.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { httpModelGate } from "../gates/http-client.js";
import { httpToolGate } from "../gates/tool-client.js";
import { createHostLogger } from "../host/logger.js";
import type { StackConfig } from "../host/stack-config.js";
import { RUNTIME_VERSION } from "../version.js";
import { localBackend } from "../adapters/sandbox/local.js";
import { awaitNetworkPolicy } from "../sandbox/pods/network-gate.js";
import { podHost, type PodHost } from "./pod.js";
import { harnessRunTokens } from "./run-tokens.js";
import { startHarnessService } from "./service.js";

/**
 * `baseline` is the allowlisted environment of a pod's sandbox tools (`baselineEnvironment`),
 * read by `host/main.ts`: nothing here reads the process environment.
 */
export async function runHarness(
  stack: StackConfig,
  baseline: Readonly<Record<string, string>>
): Promise<void> {
  const config = stack.harness!;
  const logger = createHostLogger();
  const paths = { sandboxes: join(config.root, "sandboxes") };
  mkdirSync(paths.sandboxes, { recursive: true });
  logger.info("host_stack_config", { services: [...stack.services], harness: config.url, gates: config.gatesUrl });

  // A pod's engine trusts the network only once its NetworkPolicy blocks what it must.
  let pod: PodHost | undefined;
  if (config.pod) {
    const { waitedMs } = await awaitNetworkPolicy({
      addresses: config.pod.blocked,
      log: (message, fields) => logger.info(message, fields),
    });
    logger.info("sandbox_network_policy_in_force", { sandboxId: config.pod.sandboxId, waitedMs });
    pod = podHost(config.pod, logger, { volumeFile: join(config.root, "volume-id") });
  }
  const token = pod ? () => pod.token() : config.token;
  if (token === undefined) throw new Error("--service harness needs NYLORUN_HARNESS_TOKEN");

  const runTokens = harnessRunTokens();
  const service = startHarnessService({
    url: config.url,
    token,
    ...(pod ? { sandboxBackends: [localBackend({ env: baseline, proxyEnv: () => pod.proxyEnv() })] } : {}),
    paths,
    modelGate: httpModelGate({ url: config.gatesUrl, runTokens }),
    useVaultModel: true,
    toolGate: httpToolGate({ url: config.gatesUrl, runTokens }),
    logger,
    name: pod ? `sandbox ${config.pod!.sandboxId}` : "harness",
    version: RUNTIME_VERSION,
    onGrant: (grant) => runTokens.grant(grant),
  });

  const health = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "nylorun-harness", connected: service.client.connected }));
  });
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(config.healthPort, "127.0.0.1", () => resolve());
  });
  logger.info("harness_ready", { health: `http://127.0.0.1:${config.healthPort}/health` });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // Runs are given back (core resumes them in its next advance), then MCP and sandboxes stop.
      pod?.stop();
      void service
        .stop(pod ? 7_000 : 10_000)
        .catch((error: unknown) =>
          logger.warn("harness_stop_failed", { message: error instanceof Error ? error.message : String(error) })
        )
        .finally(() => {
          health.close();
          process.exit(0);
        });
    });
}
