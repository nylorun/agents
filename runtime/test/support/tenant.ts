import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  HOST_PROTOCOL,
  newTenantId,
} from "@nylorun/core/compatibility";
import { hashToken, mintBearerToken } from "../../src/core/bearer.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { createTenantLogger } from "../../src/tenant/logger.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import {
  openTenantRuntime,
  type TenantOpenHooks,
} from "../../src/tenant/runtime.js";
import { createKekFile, readVaultKek } from "../../src/vault/kek.js";
import { HostModelVault } from "../../src/vault/host-model.js";
import type { ModelGate } from "../../src/gates/model-gate.js";
import { httpModelGate } from "../../src/gates/http-client.js";
import { httpToolGate } from "../../src/gates/tool-client.js";
import type { ToolGate } from "../../src/gates/tool-gate.js";
import { authorizeSessionMcp } from "../../src/gates/tenant-vaults.js";
import { VaultService, type AuthorizeResult } from "../../src/vault/service.js";
import { CredentialSources } from "../../src/vault/sources.js";
import { httpKeys } from "../../src/keys/client.js";
import { guardedFetch } from "../../src/tenant/outbound.js";
import { inProcessKeys, type Keys } from "../../src/keys/keys.js";
import { SigningKeys } from "../../src/tenant/signing-keys.js";
import { createRunGrants, type RunGrants } from "../../src/tenant/run-grants.js";
import type { Session } from "../../src/tenant/context.js";
import { startGates, type GatesServer } from "../../src/host/gates.js";
import { createFsBlobStore, type BlobStore } from "../../src/blob/index.js";
import type { TenantConfig, TenantHandle } from "../../src/tenant/types.js";
import type { SessionStore } from "../../src/store/types.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import type { DurableStreams } from "../../src/streams/types.js";
import { dropTestTenant, openTestTenant, withTestSessionStore } from "./store.js";

export type StartTestTenantOptions = Partial<TenantConfig> & {
  /** Action endpoints registered once the Tenant is up (`PUT /v1/endpoints`). */
  endpoints?: readonly {
    agentId: string;
    url: string;
    implementationVersion: string;
    manifestHash?: string;
    timeoutMs?: number;
    maxConcurrent?: number;
  }[];
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  /**
   * Serve the model from the Tenant's vault (the `vault` model kind). With
   * `NYLORUN_TEST_MODEL_GATE=http` the calls cross a gates service on 127.0.0.1, as they do in
   * the local stack; otherwise the Tenant calls the model in process.
   */
  useHostModel?: boolean;
  /** Serves the Tenant's vault-backed calls instead (`TenantOpenHooks.modelGate`). */
  modelGate?: ModelGate;
  /**
   * Serves the Tenant's remote MCP servers and deliveries instead (`TenantOpenHooks.toolGate`).
   * Without one, `NYLORUN_TEST_MODEL_GATE=http` sends them through a gates service on
   * 127.0.0.1, as the local stack does.
   */
  toolGate?: ToolGate;
  /** Reuse an existing Host root (restart tests). */
  hostRoot?: string;
  applicationKey?: string;
  principalId?: string;
  /** When true, close() does not delete the Host root. */
  retainRoot?: boolean;
  /** Host-level execution and Worker id (ownership tests). */
  execution?: TenantOpenHooks["execution"];
  workerId?: string;
  /**
   * Durable Streams shared with other instances (or restarts); the caller closes them.
   * Default: `MemoryStreams` for this Tenant, kept for a restart on the same Host root while
   * the root is retained, and closed by the `close()` that removes the root.
   */
  streams?: DurableStreams;
  /** How long a retired stream basin is kept after a reset. Default 60 s. */
  retireGraceMs?: number;
  /**
   * The Tenant's harness (`TenantOpenHooks.harness`). Default from `NYLORUN_TEST_HARNESS`
   * (`memory`, `json` or `ws`), else `memory`.
   */
  harness?: TenantOpenHooks["harness"];
  harnessTap?: TenantOpenHooks["harnessTap"];
  /** Sandbox pods (F7.2): the sandboxes service, e.g. `test/support/fake-sandboxes.ts`. */
  pods?: TenantOpenHooks["pods"];
  /** Wraps the Tenant's `fs` Object store (to watch what it is asked to store). */
  wrapBlobs?: (blobs: BlobStore) => BlobStore;
  /**
   * The gateway's OAuth fetch with `NYLORUN_TEST_MODEL_GATE=http` (refresh and MCP OAuth
   * connect). Default `vaultFetch`, else the Host's `guardedFetch` under `delivery`, as the
   * gateway has it; `vaultFetch` alone is then the runtime container's.
   */
  gateVaultFetch?: typeof fetch;
};

/**
 * The harness mode of the suite, `NYLORUN_TEST_HARNESS`: `memory` (default) and `json` run the
 * Tenant's harness in process over a memory channel; `ws` runs a harness service over a loopback
 * WebSocket, with its own MCP pool and sandboxes and no store (F6.2).
 */
export function testHarnessMode(): "memory" | "json" | "ws" {
  const mode = process.env.NYLORUN_TEST_HARNESS ?? "memory";
  if (mode !== "memory" && mode !== "json" && mode !== "ws")
    throw new Error(`NYLORUN_TEST_HARNESS must be memory, json or ws, not ${mode}`);
  return mode;
}

/**
 * Default streams of Tenants whose Host root outlives `close()` (`retainRoot`, `hostRoot`), by
 * `<hostRoot>\0<tenantId>`: a restart on the same root finds its history again, as it would
 * in S2, which outlives the Runtime.
 */
const retainedStreams = new Map<string, MemoryStreams>();

/**
 * Rewrites fields of a stored session of a closed Tenant (restart tests). `root` is the
 * Host root.
 */
export async function patchStoredSession(
  root: string,
  tenantId: string,
  sessionId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await withTestSessionStore({ root, tenantId }, (store) =>
    store.tx(async (t) => {
      const stored = await t.get("sessions", sessionId);
      if (!stored) throw new Error(`Session ${sessionId} not found`);
      await t.put("sessions", sessionId, { ...stored, ...patch });
    })
  );
}

/**
 * Minimal in-process HTTP shim over \`openTenantRuntime\` for runtime tests (§5.5). The
 * Tenant is the one Tenant of a database of its own (`./store.ts`), created on first start
 * and found again by a restart with the same `tenantId`. `close()` drops the database unless
 * the root is retained.
 */
export async function startTestTenant(
  options: StartTestTenantOptions = {}
): Promise<{
  url: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  principalId: string;
  headers(key?: string): Record<string, string>;
  root: string;
  handle: TenantHandle;
  /** The gates service, with `NYLORUN_TEST_MODEL_GATE=http`. */
  gate?: TestGate;
  close(): Promise<void>;
}> {
  const hostRoot =
    options.hostRoot ?? (await mkdtemp(join(tmpdir(), "nylorun-test-tenant-")));
  const tenantId = options.tenantId ?? newTenantId();
  const paths = options.paths ?? tenantPaths(hostRoot);
  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.sandboxes,
    paths.pluginData,
    paths.logs,
    dirname(paths.kek),
  ])
    mkdirSync(dir, { recursive: true });

  const applicationKey = options.applicationKey ?? mintBearerToken();
  const principalId =
    options.principalId ?? `principal_${randomBytes(8).toString("hex")}`;
  const credentialHash = hashToken(applicationKey);
  const logger =
    options.logger ?? createTenantLogger({ tenantId, logPath: paths.log });

  // A restart (same `tenantId`) finds its database again and keeps its principals.
  const result = await openTestTenant(tenantId, {
    principals: [{ id: principalId, credentialHash }],
    onError: (error) =>
      logger.error("post-commit step failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  const opened: Pick<TenantOpenHooks, "store" | "envelope"> = {
    store: result.store,
    envelope: result.envelope,
  };

  const mode = options.mode ?? "test";
  let model = options.model ?? { kind: "scripted" as const, output: "ok" };
  if (options.useHostModel) model = { kind: "vault" };
  if (
    (model.kind === "fixture" || model.kind === "scripted") &&
    mode === "shared"
  )
    throw new Error("fixture/scripted models require ephemeral or test mode");

  const childEnv = options.childEnv ?? {
    // Tests may read ambient PATH; Runtime code must not.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: paths.tmp,
  };

  const config: TenantConfig = {
    tenantId,
    mode,
    paths,
    sandbox: options.sandbox ?? { backend: "virtual" },
    model,
    childEnv,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.ownerLeaseMs === undefined
      ? {}
      : { ownerLeaseMs: options.ownerLeaseMs }),
    // A short sweep so lapsed deliveries and lost wakes are picked up promptly in tests.
    sweepIntervalMs: options.sweepIntervalMs ?? 50,
    ...(options.flow === undefined ? {} : { flow: options.flow }),
    ...(options.flowEnv === undefined ? {} : { flowEnv: options.flowEnv }),
    ...(options.issuers === undefined ? {} : { issuers: options.issuers }),
    ...(options.vaultFetch === undefined
      ? {}
      : { vaultFetch: options.vaultFetch }),
    ...(options.modelCall === undefined ? {} : { modelCall: options.modelCall }),
    ...(options.rollover === undefined ? {} : { rollover: options.rollover }),
    ...(options.actionHoldMs === undefined ? {} : { actionHoldMs: options.actionHoldMs }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    logger,
  };

  const streamsKey = `${hostRoot}\u0000${tenantId}`;
  const defaultStreams = retainedStreams.get(streamsKey) ?? new MemoryStreams();
  const hooks: TenantOpenHooks = {
    ...opened,
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.execution ? { execution: options.execution } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    streams: options.streams ?? defaultStreams,
    ...(options.retireGraceMs !== undefined ? { retireGraceMs: options.retireGraceMs } : {}),
    harness: options.harness ?? testHarnessMode(),
    ...(options.harnessTap ? { harnessTap: options.harnessTap } : {}),
    ...(options.pods ? { pods: options.pods } : {}),
    ...(options.wrapBlobs
      ? { blobs: options.wrapBlobs(createFsBlobStore({ root: paths.blobs })) }
      : {}),
    createKekIfMissing: true,
  };
  if (options.vaultKek === null) {
    hooks.vaultKek = null;
  } else if (options.vaultKek !== undefined) {
    writeFileSync(
      paths.kek,
      Buffer.isBuffer(options.vaultKek)
        ? options.vaultKek.toString("base64") + "\n"
        : options.vaultKek.endsWith("\n")
        ? options.vaultKek
        : options.vaultKek + "\n",
      { mode: 0o600 }
    );
    hooks.vaultKek = options.vaultKek;
  } else if (!existsSync(paths.kek)) {
    createKekFile(paths.kek);
  }

  let gate: TestGate | undefined;
  if (process.env.NYLORUN_TEST_MODEL_GATE === "http") {
    // The gateway holds the vault key, with the same rules `TenantRuntime.open` applies in
    // process (`createKekIfMissing`): a Tenant opened without one (`vaultKek: null`) gets a
    // new key on first use, unless it already holds ciphertext, which stays sealed.
    let key = readVaultKek({ vaultKek: hooks.vaultKek, vaultKekPath: paths.kek });
    const sealed = key
      ? 0
      : await opened.store.tx(
          async (t) => (await t.countCredentials()) + (await t.countSigningKeys())
        );
    const kek = () => {
      if (key) return key;
      if (sealed > 0)
        throw new Error(
          "Vault key-encryption key is missing for ciphertext (vault credentials or signing keys) in this Tenant"
        );
      key = createKekFile(paths.kek);
      return key;
    };
    gate = await startTestGate({
      tenantId,
      store: opened.store,
      vault: new HostModelVault({ store: opened.store, kek }),
      credentials: new VaultService({
        store: opened.store,
        kek,
        fetch: options.gateVaultFetch ?? options.vaultFetch ?? guardedFetch(options.delivery ?? {}),
      }),
      kek,
      root: paths.home,
      logger,
      ...(options.modelCall ? { settings: options.modelCall } : {}),
      ...(options.delivery ? { delivery: options.delivery } : {}),
      // The gateway reads the Tenant's blobs as core writes them (the `fs` store here).
      blobs: createFsBlobStore({ root: paths.blobs }),
      ...(options.resolver ? { resolver: options.resolver } : {}),
    });
  }
  if (options.modelGate) hooks.modelGate = options.modelGate;
  else if (options.useHostModel && gate) hooks.modelGate = gate.modelGate;
  if (options.toolGate) hooks.toolGate = options.toolGate;
  else if (gate) hooks.toolGate = gate.toolGate;
  // The keys service (F4.2): the Tenant never reads the vault key; the gate does. Its
  // advances mint their run tokens through it into the clients' grants (F5).
  if (gate) {
    hooks.keys = gate.keys;
    hooks.runGrants = gate.runGrants;
  }

  const handle = await openTenantRuntime(config, hooks);
  const tenant = getRequestListener((request, node) => handle.fetch(request, node), {
    overrideGlobalObjects: false,
  });
  const server = createServer((req, res) => {
    // SDK Transport probes /health for protocol compatibility (Host normally serves this).
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "test",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...HOST_PROTOCOL.features],
          },
          coreVersion: "test",
          hostId: "host_test",
          pid: process.pid,
        })
      );
      return;
    }
    void tenant(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to bind test tenant listener");
  const url = `http://127.0.0.1:${address.port}`;

  const headers = (key?: string): Record<string, string> => ({
    authorization: `Bearer ${key ?? applicationKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  });

  if (options.endpoints?.length) {
    const response = await fetch(`${url}/v1/endpoints`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ endpoints: options.endpoints }),
    });
    if (!response.ok)
      throw new Error(
        `Failed to register test endpoints: ${
          response.status
        } ${await response.text()}`
      );
  }

  const adminKey = randomBytes(32).toString("hex");
  const retainRoot = options.retainRoot === true || !!options.hostRoot;
  return {
    url,
    tenantId,
    applicationKey,
    adminKey,
    principalId,
    headers,
    root: hostRoot,
    handle,
    ...(gate ? { gate } : {}),
    async close() {
      await handle.close();
      await gate?.close();
      if (!options.streams) {
        if (retainRoot) retainedStreams.set(streamsKey, defaultStreams);
        else {
          retainedStreams.delete(streamsKey);
          await defaultStreams.close();
        }
      }
      // The Tenant is closed: a client's kept-alive or abandoned connection must not hold the
      // listener open until it times out.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (!retainRoot) {
        await rm(hostRoot, { recursive: true, force: true });
        await dropTestTenant(tenantId);
      }
    },
  };
}

/** A gates service and the loop's clients of it, with the run grants the clients read. */
export type TestGate = GatesServer & {
  modelGate: ModelGate;
  toolGate: ToolGate;
  keys: Keys;
  runGrants: RunGrants;
  /** Core's credential (`NYLORUN_GATES_TOKEN`). */
  token: string;
  /**
   * The gateway's vault authorization of a session's remote MCP server (F4.1): what
   * `TenantHandle.authorize` does in process, with the vault key only the gateway holds.
   */
  authorizeMcp(
    sessionId: string,
    request: { url: string; serverName?: string; agentId?: string },
  ): Promise<AuthorizeResult>;
};

/**
 * A gates service on 127.0.0.1 serving one Tenant's vault, and the loop's HTTP client of it:
 * what the local stack's `gateway` container and the runtime container's loop do. The clients
 * read run tokens from `runGrants`, which the Tenant's advances fill (`hooks.runGrants`).
 */
export async function startTestGate(options: {
  tenantId: string;
  store: SessionStore;
  vault: HostModelVault;
  /** The vault service remote MCP servers are authorized from, and keys seal with. */
  credentials?: VaultService;
  /** The vault key, for the keys service. */
  kek?: () => Buffer;
  root: string;
  logger: TenantConfig["logger"];
  settings?: TenantConfig["modelCall"];
  delivery?: TenantConfig["delivery"];
  /** The Tenant's Object store, for the files a prompt names. */
  blobs?: BlobStore;
  /** The operator's credential resolver (`NYLORUN_RESOLVER_*` on the gateway, F9 C1). */
  resolver?: TenantConfig["resolver"];
}): Promise<TestGate> {
  const token = randomBytes(32).toString("hex");
  const runGrants = createRunGrants();
  const session = (sessionId: string) =>
    options.store.tx((t) => t.get<Session>("sessions", sessionId));
  const sources = options.credentials
    ? new CredentialSources({
        vault: options.credentials,
        ...(options.resolver ? { resolver: options.resolver } : {}),
      })
    : undefined;
  const authorizeMcp = async (
    sessionId: string,
    request: { url: string; serverName?: string; agentId?: string },
  ) => {
    if (!sources) throw new Error("This test gate serves no MCP credentials");
    return authorizeSessionMcp(sources, session, sessionId, {
      url: request.url,
      serverName: request.serverName ?? "",
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    });
  };
  const keys = options.credentials
    ? inProcessKeys({
        store: options.store,
        vault: options.credentials,
        signingKeys: new SigningKeys({ tenantId: options.tenantId, kek: options.kek! }),
        kek: options.kek!,
      })
    : undefined;
  const server = await startGates({
    gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
    logger: options.logger,
    vaults: {
      open: async () => ({
        tenantId: options.tenantId,
        store: options.store,
        root: options.root,
        readHostModel: () => options.vault.readHostModel(),
        writeHostCredential: (credential) => options.vault.updateHostCredential(credential),
        session,
        authorizeMcp,
        keys: () => {
          if (!keys) throw new Error("This test gate serves no keys");
          return keys;
        },
      }),
    },
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    keys: true,
    drainMs: 0,
  });
  return Object.assign(server, {
    modelGate: httpModelGate({ url: server.url, runTokens: runGrants }),
    toolGate: httpToolGate({ url: server.url, token, runTokens: runGrants }),
    keys: httpKeys({ url: server.url, token }),
    runGrants,
    token,
    authorizeMcp,
  });
}
