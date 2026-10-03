/**
 * The harness service (`--service harness`, F6.2): the process that runs the Tenant's agent
 * segments, MCP servers and sandboxes, apart from core. It holds one credential, the harness
 * token, for core's Harness API; its model and MCP calls present the run token of the run they
 * belong to (from the `lease` answer and each renewal), never the gates' credential. It opens no
 * database, no Restate, no keys.
 *
 * Its files live under `NYLORUN_HARNESS_ROOT` (`/harness`): `sandboxes/` (workspaces and their
 * records), `plugin-data/`, and `home/` and `tmp/` for MCP stdio servers. `/health` answers on
 * 127.0.0.1 only.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { httpModelGate } from "../gates/http-client.js";
import { httpToolGate } from "../gates/tool-client.js";
import { createHostLogger } from "../host/logger.js";
import type { StackConfig } from "../host/stack-config.js";
import { RUNTIME_VERSION } from "../version.js";
import { harnessRunTokens } from "./run-tokens.js";
import { startHarnessService } from "./service.js";

/**
 * `baseline` is the allowlisted environment of MCP stdio servers (`baselineEnvironment`), read
 * by `host/main.ts`: nothing here reads the process environment.
 */
export async function runHarness(
  stack: StackConfig,
  baseline: Readonly<Record<string, string>>
): Promise<void> {
  const config = stack.harness!;
  const logger = createHostLogger();
  const paths = {
    sandboxes: join(config.root, "sandboxes"),
    pluginData: join(config.root, "plugin-data"),
    home: join(config.root, "home"),
    tmp: join(config.root, "tmp"),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  logger.info("host_stack_config", { services: [...stack.services], harness: config.url, gates: config.gatesUrl });

  const runTokens = harnessRunTokens();
  const service = startHarnessService({
    url: config.url,
    token: config.token,
    paths,
    childEnv: { ...baseline, HOME: paths.home, TMPDIR: paths.tmp },
    modelGate: httpModelGate({ url: config.gatesUrl, runTokens }),
    useVaultModel: true,
    toolGate: httpToolGate({ url: config.gatesUrl, runTokens }),
    logger,
    name: "harness",
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
      void service
        .stop(10_000)
        .catch((error: unknown) =>
          logger.warn("harness_stop_failed", { message: error instanceof Error ? error.message : String(error) })
        )
        .finally(() => {
          health.close();
          process.exit(0);
        });
    });
}
