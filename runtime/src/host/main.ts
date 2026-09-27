/**
 * Runtime Host process entry (`@nylorun/runtime/server`).
 *
 * Reads `NYLORUN_HOME` (falls back to `~/.nylorun`), and hands an environment
 * snapshot and argv to `parseStackConfig` (container listen mode, `--role`,
 * stack endpoints). Absolute Host root is resolved once and passed down.
 *
 * Composition: `createInfra` builds the Postgres pool, Durable Session
 * Execution and Durable Streams from the endpoints; `createHostExecution`
 * shares one execution across the Tenants; the Tenant store is Postgres with
 * `NYLORUN_DATABASE_URL` (required in container mode) and SQLite otherwise;
 * `/ready` reports the infrastructure checks. See the startup order in
 * `main()`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPaths } from "../tenant/paths.js";
import { createTenantModule } from "../tenant/module.js";
import { createFsTenantStore } from "../tenant/store-fs.js";
import { createPostgresTenantStore } from "../tenant/store-pg.js";
import { openTenantRuntime, type TenantOpenHooks } from "../tenant/runtime.js";
import { createTenantStreams, deleteTenantStreams } from "../tenant/streams.js";
import type {
  HostConfigFile,
  HostCredentialsFile,
  HostStateFile,
} from "./config.js";
import { configForFactory } from "./config-for.js";
import { createHost, type CreateHostOptions } from "./create-host.js";
import { createHostExecution } from "./execution.js";
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
import { createExecution, createInfra } from "../infra/index.js";
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

  // The stack runs on Postgres and S2; only a local (launcher) Host may still
  // use SQLite and in-process streams.
  if (stack.listen && !stack.endpoints.databaseUrl) {
    throw new Error(
      "NYLORUN_DATABASE_URL is required in container mode: the Postgres URL of the Session Store (`nylorun start` sets it)",
    );
  }
  if (stack.listen && !stack.endpoints.s2Endpoint) {
    throw new Error(
      "NYLORUN_S2_ENDPOINT is required in container mode: the S2 endpoint of Durable Streams (`nylorun start` sets it)",
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

  // One Durable Session Execution for every Tenant this process opens: Restate
  // when its endpoints are set, else the in-process memory execution. An
  // invocation for a Tenant that is not open here opens it on demand.
  const hostExecution = createHostExecution({
    execution: infra.execution ?? createExecution(stack),
    role: stack.role,
    resolve: (tenantId) => module.worker(tenantId),
    logger,
  });
  // Durable Streams: S2 when configured (always in container mode). Without
  // them (a local Host only) each Tenant keeps in-process streams, whose history
  // does not survive a restart.
  const streams = infra.streams;
  const hooks: TenantOpenHooks = {
    execution: hostExecution.tenantExecution,
    ...(streams ? { streams } : {}),
  };

  // With NYLORUN_DATABASE_URL, Tenants are Postgres schemas; without it (local
  // Host only, until Wave 4) each Tenant is a directory with SQLite.
  const store = infra.database
    ? createPostgresTenantStore({
        hostRoot,
        sql: infra.database,
        configFor,
        logger,
        openRuntime: (tenantConfig, opened) =>
          openTenantRuntime(tenantConfig, { ...hooks, ...opened }),
      })
    : createFsTenantStore({
        hostRoot,
        configFor,
        logger,
        openRuntime: (tenantConfig) => openTenantRuntime(tenantConfig, hooks),
      });
  logger.info("tenant_store", { kind: infra.database ? "postgres" : "sqlite" });

  const module = createTenantModule({
    store,
    logger,
    // A new Tenant's basin is created with it (opening it repairs a failure);
    // a deleted Tenant's sweep stops re-arming and its basin goes.
    ...(streams
      ? { onCreated: (tenantId: string) => createTenantStreams(streams, tenantId) }
      : {}),
    onDeleted: async (tenantId) => {
      await hostExecution.disarm(tenantId);
      if (streams) await deleteTenantStreams(streams, tenantId);
    },
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
    // SIGTERM and POST /v1/admin/host/shutdown both close the Host this way:
    // stop the Worker, close the Tenants, then end the infrastructure clients.
    shutdown: {
      beforeTenants: () => hostExecution.stop(),
      afterTenants: () => infra.close(),
    },
  };
  const host = createHost(options);

  // Startup order. The Worker starts first: opening a Tenant arms its sweep
  // through Restate's ingress, which answers 404 until a Worker has registered
  // the services, so no Tenant may open before `start` (the listener opens
  // Tenants on demand). An api-role process serves no Worker endpoint, so it
  // can open Tenants only once some Worker process has registered. Container
  // mode runs one `--role all` process, which registers here. Then the
  // listener starts (and marks discovery done), and every listed Tenant's
  // sweep is re-armed, which recovers wakes lost with Restate's state (§14.8).
  try {
    await hostExecution.start();
    await host.listen();
  } catch (error) {
    await hostExecution.stop().catch(() => undefined);
    await infra.close();
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
  const tenants = await module.list();
  await hostExecution
    .armAll(tenants.filter((t) => t.state === "open").map((t) => t.id))
    .catch((error: unknown) =>
      logger.warn("tenant_sweeps_not_armed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );

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

  logger.info("host_ready", {
    url: host.url,
    hostId: config.hostId,
    tenants: tenants.length,
  });
  process.send?.({ type: "ready", url: host.url });

  void host.closed.then(() => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void host.close());
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
