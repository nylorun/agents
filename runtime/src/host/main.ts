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
 * `NYLORUN_DERIVED_PRINCIPALS`; tenancy.md §4), trusting the issuers of the identity file
 * `NYLORUN_IDENTITY_FILE` names (Host feature `trusted-issuers`); with S2, a process running core
 * runs the stream relay, which feeds the Tenant's streams from the record over
 * logical replication (one process at a time holds the slot); `/ready` reports
 * the Tenant and the infrastructure checks. With an Object store
 * (`NYLORUN_OBJECT_STORE_*`) the Tenant's blobs go to it through the `s3` BlobStore, and a
 * process running core creates its bucket; without one they stay on disk (`fs`). A process
 * running the gates service (the local stack's `gateway` container) starts only the gate, and egress-gate with `egress` (`runGates`): it needs
 * neither host.json nor host-credentials.json, and reads the files a prompt names from the Object store. A process running the harness service (`--service harness`, F6.2)
 * starts only the harness (`harness/main.ts`), which connects to core's Harness API. With `NYLORUN_HARNESS=remote`
 * the Tenant runs no harness of its own: core starts the Harness API listener (`NYLORUN_HARNESS_LISTEN_*`) and
 * harnesses that present `NYLORUN_HARNESS_TOKEN` run its segments and hold its workspaces. See the startup order
 * in `main()`. Tests compose a Host without this entry, with `createHost` and an injected Tenant module.
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostPaths } from "../tenant/paths.js";
import { createTenantModule } from "../tenant/module.js";
import { parseIdentityFile } from "../tenant/identity-file.js";
import { createTrustedIssuers, type TrustedIssuers } from "../tenant/issuers.js";
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
import { startEgress, startGates } from "./gates.js";
import { httpToolGate } from "../gates/tool-client.js";
import { httpKeys } from "../keys/client.js";
import { httpModelGate } from "../gates/http-client.js";
import type { ObjectStoreConfig, StackConfig } from "./stack-config.js";
import { createS3BlobStore, type S3BlobStore } from "../blob/index.js";
import { createRunGrants } from "../tenant/run-grants.js";
import { runHarness } from "../harness/main.js";
import { startHarnessListener, type HarnessListener } from "../harness-api/ws-server.js";
import { httpSandboxesClient } from "../sandbox/pods/client.js";

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

/**
 * The trusted issuers of the identity file (`NYLORUN_IDENTITY_FILE`, Host feature
 * `trusted-issuers`). A missing or malformed file stops the boot, naming the issuer and field;
 * an issuer's JWKS is fetched only when a token needs it, so one that is down does not.
 */
function loadIssuers(path: string): TrustedIssuers {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `NYLORUN_IDENTITY_FILE names ${path}, which cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return createTrustedIssuers(parseIdentityFile(text, path));
}

function resolveHostRoot(): string {
  const fromEnv = process.env.NYLORUN_HOME;
  const root =
    fromEnv && fromEnv.length > 0 ? fromEnv : resolve(homedir(), ".nylorun");
  return resolve(root);
}

/** The Object store's `s3` BlobStore (D35), from `StackConfig.objectStore`. */
function objectStore(config: ObjectStoreConfig): S3BlobStore {
  return createS3BlobStore({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}

/**
 * Creates the Object store's bucket unless it exists, retrying while the store starts. In the
 * background: only artifacts use the store, so a store that stays down is logged (artifact
 * uploads and downloads fail meanwhile) and does not hold up the Host.
 */
async function ensureBucket(
  store: S3BlobStore,
  bucket: string,
  logger: ReturnType<typeof createHostLogger>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await store.ensureBucket();
      logger.info("object_store_ready", { bucket });
      return;
    } catch (error) {
      if (attempt >= 10) {
        logger.error("object_store_unavailable", {
          bucket,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
}

/** The slot's lag in WAL bytes, when the source can tell. */
async function lagOf(source: {
  lag?(): Promise<number | undefined>;
}): Promise<{ lagBytes?: number }> {
  const lagBytes = await source.lag?.().catch(() => undefined);
  return lagBytes === undefined ? {} : { lagBytes };
}

/**
 * The gateway's services: the Model Gate's listener (gates, keys) and egress-gate's (egress), over
 * the Postgres pool and the Host's tenant directory. Writes nothing to the Host root (the local
 * stack mounts it read-only).
 */
async function runGates(stack: StackConfig): Promise<void> {
  if (!stack.endpoints.databaseUrl)
    throw new Error(
      `NYLORUN_DATABASE_URL is required for --service ${describeServices(stack.services)}: the gateway reads the Tenant from Postgres (\`nylorun start\` sets it)`,
    );
  const logger = createHostLogger();
  logger.info("host_stack_config", {
    services: [...stack.services],
    ...(stack.packing ? { packing: stack.packing } : {}),
    endpoints: describeEndpoints(stack.endpoints),
    objectStore: stack.objectStore ? "s3" : "none",
    // Never the resolver's URL or token: only whether one is set (F9 C1).
    resolver: stack.gates?.resolver ? "configured" : "none",
  });
  const database = createDatabase(stack);
  const servers: { close(): Promise<void> }[] = [];
  try {
    if (stack.gates) {
      const server = await startGates({
        gates: stack.gates,
        database,
        hostRoot: resolveHostRoot(),
        logger,
        ...(stack.delivery ? { delivery: stack.delivery } : {}),
        ...(stack.services.has("keys") ? { keys: true } : {}),
        // Model-gate reads the files a prompt names from the Object store (protocol 6).
        ...(stack.objectStore ? { blobs: objectStore(stack.objectStore) } : {}),
      });
      servers.push(server);
      logger.info("gates_ready", { url: server.url });
    }
    if (stack.egress) {
      const egress = await startEgress({ egress: stack.egress, database, hostRoot: resolveHostRoot(), logger });
      servers.push(egress);
      logger.info("egress_ready", { url: egress.url });
    }
  } catch (error) {
    await Promise.all(servers.map((server) => server.close()));
    await database.end({ timeout: 5 });
    if (error instanceof HostListenError) {
      logger.error("listen_failed", { message: error.message, exitCode: error.exitCode });
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void Promise.all(servers.map((server) => server.close()))
        .then(() => database.end({ timeout: 5 }))
        .finally(() => process.exit(0));
    });
}

export async function main(): Promise<void> {
  const stack = parseStackConfig(process.env, process.argv.slice(2));
  if (stack.services.has("gates") || stack.services.has("keys") || stack.services.has("egress"))
    return runGates(stack);
  if (stack.services.has("harness")) return runHarness(stack, baselineEnvironment(process.env));
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
  const identityFile = stack.tenant?.identityFile;
  const issuers = identityFile ? loadIssuers(identityFile) : undefined;
  const logger = createHostLogger();
  if (issuers)
    logger.info("trusted_issuers", {
      file: identityFile,
      issuers: issuers.issuers.map((issuer) => issuer.config.name),
    });
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
    harness: stack.harnessMode ?? "in-process",
    mode: stack.listen ? "container" : "local",
    endpoints: describeEndpoints(stack.endpoints),
    objectStore: stack.objectStore ? "s3" : "fs",
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
    ...(issuers ? { issuers } : {}),
    ...(stack.publicUrl ? { publicUrl: stack.publicUrl } : {}),
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
  // Their credentials (F5): each advance's run token for its session's model and MCP calls,
  // core's credential (NYLORUN_GATES_TOKEN) for deliveries and MCP requests outside a run.
  const runGrants = stack.modelGate ? createRunGrants() : undefined;
  const modelGate =
    stack.modelGate && runGrants
      ? httpModelGate({ url: stack.modelGate.url, runTokens: runGrants })
      : undefined;
  const toolGate =
    stack.modelGate && runGrants
      ? httpToolGate({ url: stack.modelGate.url, token: stack.modelGate.token, runTokens: runGrants })
      : undefined;
  // With the keys service, vault writes and token signing cross it, and this process never
  // reads the vault key (F4.2).
  const keys = stack.keys ? httpKeys({ url: stack.keys.url, token: stack.keys.token }) : undefined;
  // The Object store (D35): the stack's S3 server through the BlobStore seam, handed to the
  // Tenant (`TenantContext.blobs`). Without one the Tenant keeps blobs on disk. core creates
  // the bucket.
  const blobs = stack.objectStore ? objectStore(stack.objectStore) : undefined;
  if (blobs && stack.services.has("core"))
    void ensureBucket(blobs, stack.objectStore!.bucket, logger);
  // Sandbox pods (F7.2): the sandboxes service, which alone holds the cluster's credentials.
  const pods = stack.sandboxes
    ? {
        client: httpSandboxesClient({ url: stack.sandboxes.url, token: stack.sandboxes.token }),
        harnessImage: stack.sandboxes.harnessImage,
      }
    : undefined;
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
          ...(runGrants ? { runGrants } : {}),
          ...(keys ? { keys } : {}),
          ...(streams ? { streams, hostRelay: true } : {}),
          ...(blobs ? { blobs } : {}),
          ...(stack.harnessMode === "remote" ? { harness: "remote" as const } : {}),
          ...(pods ? { pods } : {}),
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
        // The harnesses' runs stop with the Tenant's advances; their connections close after.
      },
      afterTenants: async () => {
        await harnessListener?.close();
        await infra.close();
      },
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
  // The Harness API listener (NYLORUN_HARNESS=remote): only harnesses connect here, with the
  // harness credential, and only while the Tenant is open.
  let harnessListener: HarnessListener | undefined;
  try {
    await hostExecution.start();
    if (stack.harnessListener)
      harnessListener = await startHarnessListener({
        ...stack.harnessListener.listen,
        ...(stack.harnessListener.token ? { token: stack.harnessListener.token } : {}),
        // Sandbox pods join here and connect with host tokens (F7.2).
        ...(pods
          ? {
              hosts: async () => {
                const resolved = await module.resolve();
                return resolved.kind === "open" ? resolved.handle.hostAuthority?.() : undefined;
              },
            }
          : {}),
        attach: async () => {
          const resolved = await module.resolve();
          const handle = resolved.kind === "open" ? resolved.handle : undefined;
          return handle?.attachHarness ? (channel, peer) => handle.attachHarness!(channel, peer) : undefined;
        },
        logger,
      });
    await host.listen();
  } catch (error) {
    await harnessListener?.close().catch(() => undefined);
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
    ...(harnessListener ? { harness: harnessListener.url } : {}),
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
