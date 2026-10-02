/**
 * Runtime Host process entry (`@nylorun/runtime/server`).
 *
 * Reads `NYLORUN_HOME` (falls back to `~/.nylorun`), and hands an environment
 * snapshot and argv to `parseStackConfig` (container listen mode, `--service`,
 * stack endpoints). Absolute Host root is resolved once and passed down.
 *
 * Composition: `createInfra` builds the Postgres pool, Durable Session
 * Execution and Durable Streams from the endpoints; `createHostExecution`
 * shares one execution across the Tenants; the Tenant store is Postgres
 * (`NYLORUN_DATABASE_URL`, required), with the shared record of session events
 * (`nylorun_streams`, migrated here); with S2, a process running core runs
 * the stream relay, which feeds every Tenant's streams from the record over
 * logical replication (one process at a time holds the slot); `/ready` reports
 * the infrastructure checks. See the startup order in `main()`. Tests compose a Host without this
 * entry, with `createHost` and an injected Tenant module.
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostPaths, trashSqliteTenants } from "../tenant/paths.js";
import { createTenantModule } from "../tenant/module.js";
import { createPostgresTenantStore } from "../tenant/store-pg.js";
import { openTenantRuntime } from "../tenant/runtime.js";
import { createTenantStreams, deleteTenantStreams } from "../tenant/streams.js";
import { createPgoutputSource } from "../adapters/replication/pgoutput.js";
import {
  assertLogicalReplication,
  migrateStreamsSchema,
} from "../store/postgres/migrations/shared/index.js";
import { createPostgresRecordReader } from "../store/postgres/record.js";
import { createStreamRelay, type StreamRelay } from "../streams/relay/core.js";
import type { HostConfigFile, HostCredentialsFile } from "./config.js";
import { configForFactory } from "./config-for.js";
import { createHost, type CreateHostOptions } from "./create-host.js";
import { createHostExecution } from "./execution.js";
import { baselineEnvironment } from "./environment.js";
import {
  HostListenError,
  EXIT_PORT_IN_USE,
  EXIT_NON_LOOPBACK,
} from "./http.js";
import { createHostLogger } from "./logger.js";
import {
  describeEndpoints,
  describeServices,
  parseStackConfig,
} from "./stack-config.js";
import { createExecution, createInfra } from "../infra/index.js";

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

/** The slot's lag in WAL bytes, when the source can tell. */
async function lagOf(source: {
  lag?(): Promise<number | undefined>;
}): Promise<{ lagBytes?: number }> {
  const lagBytes = await source.lag?.().catch(() => undefined);
  return lagBytes === undefined ? {} : { lagBytes };
}

export async function main(): Promise<void> {
  const stack = parseStackConfig(process.env, process.argv.slice(2));
  const hostRoot = resolveHostRoot();
  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(paths.tenants, { recursive: true });

  if (!existsSync(paths.config)) {
    throw new Error(
      `Missing host.json at ${paths.config}; run \`nylorun start\` first`,
    );
  }
  if (!existsSync(paths.credentials)) {
    throw new Error(
      `Missing host-credentials.json at ${paths.credentials}; run \`nylorun start\` first`,
    );
  }

  // Tenants are Postgres schemas. Only a Host outside a container (a local
  // development Host) may run without S2, on in-process streams.
  if (!stack.endpoints.databaseUrl) {
    throw new Error(
      "NYLORUN_DATABASE_URL is required: the Postgres URL of the Session Store (`nylorun start` sets it)",
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
  if (stack.deprecatedRole)
    logger.warn("deprecated_flag", {
      flag: "--role",
      use: `--service ${describeServices(stack.services)}`,
    });
  logger.info("host_stack_config", {
    services: [...stack.services],
    mode: stack.listen ? "container" : "local",
    endpoints: describeEndpoints(stack.endpoints),
  });
  // Tenants from the SQLite Runtime are not migrated: move them out of the way.
  trashSqliteTenants(hostRoot, logger);
  const infra = createInfra(stack, { logger });
  const database = infra.database;
  if (!database) throw new Error("NYLORUN_DATABASE_URL did not yield a Postgres pool");
  const baseline = baselineEnvironment(process.env);

  // A Tenant that should answer with the fixture model carries the Tenant
  // setting (`tenant/model-setting.ts`); the Host has no fixture mode.
  const configFor = configForFactory({
    hostRoot,
    hostConfig: config,
    logger,
    baseline,
    ...(stack.delivery ? { delivery: stack.delivery } : {}),
  });

  // One Durable Session Execution for every Tenant this process opens: Restate
  // when its endpoints are set, else the in-process memory execution. An
  // invocation for a Tenant that is not open here opens it on demand.
  const hostExecution = createHostExecution({
    execution: infra.execution ?? createExecution(stack),
    services: stack.services,
    resolve: (tenantId) => module.worker(tenantId),
    logger,
  });
  // Durable Streams: S2 when configured (always in container mode). Without
  // them (a local Host only) each Tenant keeps in-process streams, whose history
  // does not survive a restart.
  const streams = infra.streams;
  let relayLag:
    | (() => Promise<ReturnType<StreamRelay["status"]> & { lagBytes?: number }>)
    | undefined;
  // The record of session events is shared by every Tenant; it exists before any opens.
  await migrateStreamsSchema(database);
  // With S2, the stream relay feeds every Tenant's streams from the record. Every process
  // running core runs one; the replication slot lets exactly one be active. Without S2, each
  // Tenant relays its own commits to its in-process streams.
  let relay: StreamRelay | undefined;
  if (streams && stack.services.has("core")) {
    await assertLogicalReplication(database);
    const source = createPgoutputSource({
      connectionString: stack.endpoints.databaseUrl,
      log: (message, fields) => logger.info(message, fields),
    });
    relay = createStreamRelay({
      source,
      record: createPostgresRecordReader(database),
      streams,
      log: (message, fields) => logger.info(message, fields),
    });
    const status = relay.status;
    relayLag = async () => ({ ...status(), ...(await lagOf(source)) });
  }
  const store = createPostgresTenantStore({
    hostRoot,
    sql: database,
    configFor,
    logger,
    openRuntime: (tenantConfig, opened) =>
      openTenantRuntime(tenantConfig, {
        execution: hostExecution.tenantExecution,
        ...(streams ? { streams, hostRelay: true } : {}),
        ...opened,
      }),
  });

  const module = createTenantModule({
    store,
    logger,
    ...(relayLag ? { relayStatus: relayLag } : {}),
    // A new Tenant's basin is created with it (opening it repairs a failure);
    // a deleted Tenant's sweep stops re-arming and its basin goes.
    ...(streams
      ? { onCreated: (tenantId: string) => createTenantStreams(streams, tenantId) }
      : {}),
    onDeleted: async (tenantId) => {
      const failed = (
        await Promise.allSettled([
          hostExecution.disarm(tenantId),
          ...(streams ? [deleteTenantStreams(streams, tenantId)] : []),
        ])
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failed.length > 0)
        throw new AggregateError(failed, "Deleted Tenant cleanup failed");
    },
  });

  const options: CreateHostOptions = {
    hostRoot,
    module,
    config,
    credentials,
    logger,
    coreVersion: coreVersion(),
    ...(stack.listen ? { listen: stack.listen } : {}),
    ...(stack.publicUrl ? { publicUrl: stack.publicUrl } : {}),
    // Container mode (the local stack) allows browsers unless told not to; a Host started
    // from host.json only when it says so. Without publishable keys nothing is reachable.
    browserAccess:
      stack.browserAccess ?? (stack.listen ? true : config.browserAccess === true),
    // The Admin API on its own listener: from the container environment, or from host.json
    // (loopback, on the same host) when the Host runs outside a container.
    ...(stack.operator
      ? { operator: stack.operator }
      : !stack.listen && typeof config.adminPort === "number"
        ? { operator: { host: config.host, port: config.adminPort } }
        : {}),
    ...(infra.readiness ? { readiness: infra.readiness } : {}),
    // SIGTERM and POST /v1/admin/host/shutdown both close the Host this way:
    // stop the Worker, close the Tenants, then end the infrastructure clients.
    shutdown: {
      beforeTenants: async () => {
        await hostExecution.stop();
        await relay?.stop();
      },
      afterTenants: () => infra.close(),
    },
  };
  const host = createHost(options);

  // Startup order. The Worker starts first: opening a Tenant arms its sweep
  // through Restate's ingress, which answers 404 until a Worker has registered
  // the services, so no Tenant may open before `start` (the listener opens
  // Tenants on demand). A core-only process serves no Worker endpoint, so it
  // can open Tenants only once some Worker process has registered. Container
  // mode runs one `--service core,loop` process, which registers here. Then the
  // listener starts (and marks discovery done), and every listed Tenant's
  // sweep is re-armed, which recovers wakes lost with Restate's state (§14.8).
  try {
    await hostExecution.start();
    relay?.start();
    await host.listen();
  } catch (error) {
    await hostExecution.stop().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
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

  logger.info("host_ready", {
    url: host.url,
    hostId: config.hostId,
    tenants: tenants.length,
  });

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
