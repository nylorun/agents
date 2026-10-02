/**
 * Runtime Host process entry (`@nylorun/runtime/server`).
 *
 * Reads `NYLORUN_HOME` (falls back to `~/.nylorun`), and hands an environment
 * snapshot and argv to `parseStackConfig` (container listen mode, `--service`,
 * stack endpoints). Absolute Host root is resolved once and passed down.
 *
 * Composition: `createInfra` builds the Postgres pool, Durable Session
 * Execution and Durable Streams from the endpoints; `createHostExecution`
 * builds the process's execution; the Host serves the one Tenant its Postgres
 * database holds (`NYLORUN_DATABASE_URL`, required), and creates it there on
 * first start (`NYLORUN_TENANT_ID`, `NYLORUN_TENANT_NAME`,
 * `NYLORUN_DERIVED_PRINCIPALS`; tenancy.md §4); with S2, a process running core
 * runs the stream relay, which feeds the Tenant's streams from the record over
 * logical replication (one process at a time holds the slot); `/ready` reports
 * the Tenant and the infrastructure checks. A process running the gates service (the local
 * stack's `gateway` container) starts only the gate (`runGates`): it needs
 * neither host.json nor host-credentials.json. See the startup order in `main()`. Tests compose a Host without this
 * entry, with `createHost` and an injected Tenant module.
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostPaths } from "../tenant/paths.js";
import { createTenantModule } from "../tenant/module.js";
import { hostPrincipals } from "../tenant/principals.js";
import { createPostgresTenantOpener } from "../tenant/store-pg.js";
import { openTenantRuntime } from "../tenant/runtime.js";
import { createPgoutputSource } from "../adapters/replication/pgoutput.js";
import { assertLogicalReplication } from "../store/postgres/connect.js";
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
import { createDatabase } from "../infra/database.js";
import { startGates } from "./gates.js";
import { httpToolGate } from "../gates/tool-client.js";
import { httpKeys } from "../keys/client.js";
import { httpModelGate } from "../gates/http-client.js";
import type { StackConfig } from "./stack-config.js";

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

/**
 * The gates service: the Model Gate's listener over the Postgres pool and the Host's tenant
 * directory. Writes nothing to the Host root (the local stack mounts it read-only).
 */
async function runGates(stack: StackConfig): Promise<void> {
  const gates = stack.gates!;
  if (!stack.endpoints.databaseUrl)
    throw new Error(
      "NYLORUN_DATABASE_URL is required for --service gates: the gate reads Tenant vaults from Postgres (`nylorun start` sets it)",
    );
  const logger = createHostLogger();
  logger.info("host_stack_config", {
    services: [...stack.services],
    ...(stack.packing ? { packing: stack.packing } : {}),
    endpoints: describeEndpoints(stack.endpoints),
  });
  const database = createDatabase(stack);
  let server;
  try {
    server = await startGates({
      gates,
      database,
      hostRoot: resolveHostRoot(),
      logger,
      ...(stack.delivery ? { delivery: stack.delivery } : {}),
      ...(stack.services.has("keys") ? { keys: true } : {}),
    });
  } catch (error) {
    await database.end({ timeout: 5 });
    if (error instanceof HostListenError) {
      logger.error("listen_failed", { message: error.message, exitCode: error.exitCode });
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
  logger.info("gates_ready", { url: server.url });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void server
        .close()
        .then(() => database.end({ timeout: 5 }))
        .finally(() => process.exit(0));
    });
}

export async function main(): Promise<void> {
  const stack = parseStackConfig(process.env, process.argv.slice(2));
  if (stack.services.has("gates") || stack.services.has("keys")) return runGates(stack);
  const hostRoot = resolveHostRoot();
  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });

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

  // The Tenant is a Postgres database. Only a Host outside a container (a local
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
    ...(stack.packing ? { packing: stack.packing } : {}),
    ...(stack.services.has("loop")
      ? { modelGate: stack.modelGate ? stack.modelGate.url : "in-process" }
      : {}),
    mode: stack.listen ? "container" : "local",
    endpoints: describeEndpoints(stack.endpoints),
  });
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

  // The process's Durable Session Execution: Restate when its endpoints are set, else the
  // in-process memory execution. An invocation that arrives while the Tenant opens waits for it.
  const hostExecution = createHostExecution({
    execution: infra.execution ?? createExecution(stack),
    services: stack.services,
    resolve: (tenantId) => module.worker(tenantId),
    logger,
  });
  // Durable Streams: S2 when configured (always in container mode). Without
  // them (a local Host only) the Tenant keeps in-process streams, whose history
  // does not survive a restart.
  const streams = infra.streams;
  // With S2, the stream relay feeds the Tenant's streams from the record. Every process
  // running core runs one, once the Tenant is open (the relay reads its id); the replication
  // slot lets exactly one be active. Without S2, the Tenant relays its own commits.
  let relay: StreamRelay | undefined;
  let relayLag:
    | (() => Promise<ReturnType<StreamRelay["status"]> & { lagBytes?: number }>)
    | undefined;
  if (streams && stack.services.has("core")) await assertLogicalReplication(database);
  const startRelay = (tenantId: string) => {
    if (!streams || !stack.services.has("core") || relay) return;
    const source = createPgoutputSource({
      connectionString: stack.endpoints.databaseUrl!,
      tenantId,
      log: (message, fields) => logger.info(message, fields),
    });
    relay = createStreamRelay({
      source,
      record: createPostgresRecordReader(database, { tenantId }),
      streams,
      log: (message, fields) => logger.info(message, fields),
    });
    const status = relay.status;
    relayLag = async () => ({ ...status(), ...(await lagOf(source)) });
    relay.start();
  };
  // With the gates service the Tenant's vault-backed model calls, remote MCP calls and Action
  // deliveries cross it, and this process never reads a model or MCP credential.
  const modelGate = stack.modelGate
    ? httpModelGate({ url: stack.modelGate.url, token: stack.modelGate.token })
    : undefined;
  const toolGate = stack.modelGate
    ? httpToolGate({ url: stack.modelGate.url, token: stack.modelGate.token })
    : undefined;
  // With the keys service, vault writes and token signing cross it, and this process never
  // reads the vault key (F4.2).
  const keys = stack.keys ? httpKeys({ url: stack.keys.url, token: stack.keys.token }) : undefined;
  const tenantSettings = stack.tenant ?? { name: "default", derivedPrincipals: ["project"] };
  const module = createTenantModule({
    open: createPostgresTenantOpener({
      hostRoot,
      sql: database,
      create: {
        ...(tenantSettings.id ? { tenantId: tenantSettings.id } : {}),
        name: tenantSettings.name,
        principals: hostPrincipals({
          adminKey: credentials.adminKey,
          derived: tenantSettings.derivedPrincipals,
        }),
      },
      configFor,
      logger,
      openRuntime: (tenantConfig, opened) =>
        openTenantRuntime(tenantConfig, {
          execution: hostExecution.tenantExecution,
          ...(modelGate ? { modelGate } : {}),
          ...(toolGate ? { toolGate } : {}),
          ...(keys ? { keys } : {}),
          ...(streams ? { streams, hostRelay: true } : {}),
          ...opened,
        }),
    }),
    logger,
    onOpen: (handle) => startRelay(handle.envelope.id),
    relayStatus: async () => {
      if (!relayLag) throw new Error("no relay");
      return relayLag();
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
    // stop the Worker and the relay, close the Tenant, then end the infrastructure clients.
    shutdown: {
      beforeTenants: async () => {
        await hostExecution.stop();
        await relay?.stop();
      },
      afterTenants: () => infra.close(),
    },
  };
  const host = createHost(options);

  // Startup order. The Worker starts first: opening the Tenant arms its sweep
  // through Restate's ingress, which answers 404 until a Worker has registered
  // the services, so the Tenant may not open before `start`. A core-only
  // process serves no Worker endpoint, so it can open the Tenant only once some
  // Worker process has registered (until then the open is retried). Container
  // mode runs one `--service core,loop` process, which registers here. Then the
  // listener starts and opens the Tenant (migrating its database, creating it on
  // first start); opening arms its sweep, which recovers wakes lost with
  // Restate's state (§14.8), and starts the stream relay. A Tenant that cannot
  // be opened leaves the Host listening but not ready, with the cause in
  // `/v1/admin/status`.
  try {
    await hostExecution.start();
    await host.listen();
  } catch (error) {
    await hostExecution.stop().catch(() => undefined);
    await module.close().catch(() => undefined);
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

  const tenant = module.tenant();
  logger.info("host_ready", {
    url: host.url,
    hostId: config.hostId,
    tenantId: tenant.id,
    tenant: tenant.state,
    ...(tenant.cause ? { cause: tenant.cause.code } : {}),
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
