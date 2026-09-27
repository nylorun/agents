/**
 * Runtime Host process entry (`@nylorun/runtime/server`).
 *
 * Reads `NYLORUN_HOME` (falls back to `~/.nylorun`), and hands an environment
 * snapshot and argv to `parseStackConfig` (container listen mode, `--role`,
 * stack endpoints). Absolute Host root is resolved once and passed down.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPaths } from "../tenant/paths.js";
import { createTenantModule } from "../tenant/module.js";
import { createFsTenantStore } from "../tenant/store-fs.js";
import { openTenantRuntime } from "../tenant/runtime.js";
import { bootstrapPrincipal } from "../tenant/principals.js";
import { migrateTenantDatabase } from "../tenant/schema.js";
import type { TenantConfig } from "../tenant/types.js";
import type {
  HostConfigFile,
  HostCredentialsFile,
  HostStateFile,
} from "./config.js";
import { configForFactory } from "./config-for.js";
import { createHost, type CreateHostOptions } from "./create-host.js";
import {
  baselineEnvironment,
  hostProcessEnvironment,
} from "./environment.js";
import {
  HostListenError,
  EXIT_PORT_IN_USE,
  EXIT_NON_LOOPBACK,
} from "./http.js";
import { createHostLogger } from "./logger.js";
import { describeEndpoints, parseStackConfig } from "./stack-config.js";
import { createInfra } from "../infra/index.js";
import { RUNTIME_VERSION } from "../version.js";

const entry = fileURLToPath(import.meta.url);
const nodeRequire = createRequire(import.meta.url);

function coreVersion(): string {
  try {
    return nodeRequire("@nylorun/core/package.json").version as string;
  } catch {
    return "unknown";
  }
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function resolveHostRoot(): string {
  const fromEnv = process.env.NYLORUN_HOME;
  const root =
    fromEnv && fromEnv.length > 0 ? fromEnv : resolve(homedir(), ".nylorun");
  return resolve(root);
}

export async function main(): Promise<void> {
  const stack = parseStackConfig(process.env, process.argv.slice(2));
  const hostRoot = resolveHostRoot();
  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(paths.tenants, { recursive: true });

  const setup = stack.listen ? "nylorun start" : "nylorun runtime up";
  if (!existsSync(paths.config)) {
    throw new Error(
      `Missing host.json at ${paths.config}; run \`${setup}\` first`,
    );
  }
  if (!existsSync(paths.credentials)) {
    throw new Error(
      `Missing host-credentials.json at ${paths.credentials}; run \`${setup}\` first`,
    );
  }

  const config = loadJson<HostConfigFile>(paths.config);
  const credentials = loadJson<HostCredentialsFile>(paths.credentials);
  const logger = createHostLogger();
  logger.info("host_stack_config", {
    role: stack.role,
    mode: stack.listen ? "container" : "local",
    endpoints: describeEndpoints(stack.endpoints),
  });
  // Wave 3 prep: the clients back `/ready` only; Tenants still use SQLite.
  const infra = createInfra(stack, { logger });
  const baseline = baselineEnvironment(process.env);
  void hostProcessEnvironment(baseline, config, paths);

  // Credential-free release/dev fixture (create-agent / CI smokes). Requires
  // ephemeral mode so fixture models are allowed (Tenants D10).
  const useFixture = process.env.NYLORUN_DEV_MODEL?.trim() === "fixture";
  const configFor = configForFactory({
    hostRoot,
    hostConfig: config,
    logger,
    baseline,
    ...(useFixture
      ? { mode: "ephemeral" as const, model: { kind: "fixture" as const } }
      : {}),
  });
  const openRuntime = (tenantConfig: TenantConfig) =>
    openTenantRuntime(tenantConfig);

  const store = createFsTenantStore({
    hostRoot,
    openRuntime,
    configFor,
    logger,
    writeBootstrap: (db, bootstrap) => {
      migrateTenantDatabase(db);
      bootstrapPrincipal(db, bootstrap);
    },
  });

  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger,
  });

  const options: CreateHostOptions = {
    hostRoot,
    module,
    config,
    credentials,
    logger,
    coreVersion: coreVersion(),
    ...(stack.listen ? { listen: stack.listen, ownsStateFile: false } : {}),
    ...(stack.publicUrl ? { publicUrl: stack.publicUrl } : {}),
    ...(infra.readiness ? { readiness: infra.readiness } : {}),
  };
  const host = createHost(options);

  try {
    await host.listen();
  } catch (error) {
    if (error instanceof HostListenError) {
      logger.error("listen_failed", {
        message: error.message,
        exitCode: error.exitCode,
      });
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  // host-state.json tracks a launcher-spawned process on this machine. A
  // container's pid means nothing on the Docker host, so it writes none.
  if (!stack.listen) {
    const state: HostStateFile = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: RUNTIME_VERSION,
      entry,
      url: host.url,
    };
    writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  logger.info("host_ready", { url: host.url, hostId: config.hostId });
  process.send?.({ type: "ready", url: host.url });

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= host.close().then(() => infra.close()).then(() => {
      process.exit(0);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, shutdown);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (error instanceof HostListenError) {
    process.exit(error.exitCode);
  }
  process.exit(1);
});

export { EXIT_PORT_IN_USE, EXIT_NON_LOOPBACK };
