/**
 * Shared fixtures for WS-G security suites (hostile Host, two Tenants).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { createHost, type HostServer } from "../../src/host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../../src/host/config.js";
import {
  baselineEnvironment,
  tenantChildEnvironment,
} from "../../src/host/environment.js";
import { createHostLogger } from "../../src/host/logger.js";
import { mintBearerToken } from "../../src/core/executors.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { createTenantLogger } from "../../src/tenant/logger.js";
import { hostPaths, tenantPaths } from "../../src/tenant/paths.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import { createKekFile } from "../../src/vault/kek.js";
import type {
  TenantConfig,
  TenantModelConfig,
  TenantModule,
} from "../../src/tenant/types.js";
import type { ModelProvider } from "../../src/core/provider.js";
import type { TenantOpenHooks } from "../../src/tenant/runtime.js";

export const HOSTILE_VAULT_KEK = Buffer.alloc(32, 0xab).toString("base64");
export const HOSTILE_MODEL_KEY = "sk-hostile-model-provider-key-do-not-use";
export const HOSTILE_OPENAI_KEY = "sk-hostile-openai-key-do-not-use";
export const HOSTILE_SANDBOX = "none";
export const CLOUD_CREDENTIAL_MARKER = "AKIA_HOSTILE_CLOUD_CREDENTIAL_MARKER";

const roots: string[] = [];
const live: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of live.splice(0)) await item.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function protocolHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
    ...extra,
  };
}

export function tenantHeaders(
  tenantId: string,
  key: string,
): Record<string, string> {
  return protocolHeaders({
    [TENANT_HEADER]: tenantId,
    authorization: `Bearer ${key}`,
  });
}

export async function getRaw(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(url, init);
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

export async function getJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers; raw: string }> {
  const raw = await getRaw(url, init);
  let body: unknown = raw.body;
  try {
    body = raw.body ? JSON.parse(raw.body) : undefined;
  } catch {
    /* keep text */
  }
  return { ...raw, body, raw: raw.body };
}

/** Headers comparable for indistinguishability (exclude date / volatile). */
export function comparableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "date") return;
    out[lower] = value;
  });
  return out;
}

export interface SecurityTenant {
  id: string;
  name: string;
  applicationKey: string;
  principalId: string;
  headers(key?: string): Record<string, string>;
  paths: ReturnType<typeof tenantPaths>;
}

export interface SecurityHost {
  url: string;
  hostRoot: string;
  adminKey: string;
  hostId: string;
  module: TenantModule;
  host: HostServer;
  tenants: SecurityTenant[];
  hostLogLines: string[];
  /** Ambient HOME used for "real user" cloud credential bait. */
  ambientHome: string;
  close(): Promise<void>;
}

export const HOSTILE_ENV_KEYS = [
  "NYLORUN_VAULT_KEK",
  "MODEL_PROVIDER_API_KEY",
  "OPENAI_API_KEY",
  "NYLORUN_SANDBOX",
  "NODE_OPTIONS",
] as const;

/**
 * Apply the §23 hostile environment onto `process.env`.
 * Returns a restore function.
 */
export function applyHostileEnv(evilJsPath: string): () => void {
  const previous: Record<string, string | undefined> = {};
  const next: Record<string, string> = {
    NYLORUN_VAULT_KEK: HOSTILE_VAULT_KEK,
    MODEL_PROVIDER_API_KEY: HOSTILE_MODEL_KEY,
    OPENAI_API_KEY: HOSTILE_OPENAI_KEY,
    NYLORUN_SANDBOX: HOSTILE_SANDBOX,
    NODE_OPTIONS: `--require ${evilJsPath}`,
  };
  for (const key of Object.keys(next)) {
    previous[key] = process.env[key];
    process.env[key] = next[key];
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function writeEvilJs(directory: string): Promise<{
  path: string;
  markerPath: string;
}> {
  const markerPath = join(directory, "evil-loaded.marker");
  const path = join(directory, "evil.js");
  writeFileSync(
    path,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "loaded");\n`,
  );
  return { path, markerPath };
}

export async function writeFakeCloudHome(home: string): Promise<void> {
  const aws = join(home, ".aws");
  mkdirSync(aws, { recursive: true });
  writeFileSync(
    join(aws, "credentials"),
    `[default]\naws_access_key_id = ${CLOUD_CREDENTIAL_MARKER}\naws_secret_access_key = hostile-secret\n`,
    { mode: 0o600 },
  );
  mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "gcloud", "credentials.db"),
    CLOUD_CREDENTIAL_MARKER,
    { mode: 0o600 },
  );
}

/**
 * In-process Host with real Tenant Runtimes (two by default).
 * Simulates Host wiring from `host/main.ts` without reading ambient for config.
 */
export async function startSecurityHost(options?: {
  tenantNames?: readonly string[];
  model?: TenantModelConfig;
  sandboxBackend?: "auto" | "virtual";
  /** When true, childEnv is built from baselineEnvironment(process.env). */
  useHostileBaseline?: boolean;
  modelProvider?: ModelProvider;
  retainRoot?: boolean;
}): Promise<SecurityHost> {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-sec-host-"));
  roots.push(hostRoot);
  const ambientHome = await mkdtemp(join(tmpdir(), "nylorun-sec-home-"));
  roots.push(ambientHome);
  await writeFakeCloudHome(ambientHome);

  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(paths.tenants, { recursive: true });
  mkdirSync(paths.trash, { recursive: true });

  const hostId = `host_${newTenantId().slice(3)}`;
  const adminKey = randomBytes(32).toString("hex");
  const config: HostConfigFile = {
    hostId,
    host: "127.0.0.1",
    port: 0,
  };
  const credentials: HostCredentialsFile = { adminKey };
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    paths.credentials,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { mode: 0o600 },
  );

  const hostLogLines: string[] = [];
  const hostLogger = createHostLogger((line) => hostLogLines.push(line));

  const baseline = options?.useHostileBaseline
    ? baselineEnvironment(process.env)
    : { PATH: process.env.PATH ?? "/usr/bin:/bin" };

  const model: TenantModelConfig =
    options?.model ?? ({ kind: "scripted", output: "ok" } as const);
  const sandboxBackend = options?.sandboxBackend ?? "virtual";

  const configFor = (tenantId: string): TenantConfig => {
    const tenant = tenantPaths(hostRoot, tenantId);
    const childEnv = tenantChildEnvironment(baseline, config, tenant);
    return {
      tenantId,
      mode: "test",
      paths: tenant,
      sandbox: { backend: sandboxBackend },
      model,
      childEnv: Object.freeze(childEnv),
      logger: createTenantLogger({
        tenantId,
        logPath: tenant.log,
      }),
    };
  };

  const openHooks: TenantOpenHooks = {
    createKekIfMissing: true,
    ...(options?.modelProvider
      ? { modelProvider: options.modelProvider }
      : {}),
  };
  const openRuntime = (tenantConfig: TenantConfig) =>
    openTenantRuntime(tenantConfig, openHooks);

  const store = createFsTenantStore({
    hostRoot,
    openRuntime,
    configFor,
    logger: hostLogger,
  });

  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger: hostLogger,
  });

  await module.start();

  const names = options?.tenantNames ?? ["alpha", "beta"];
  const tenants: SecurityTenant[] = [];
  for (const name of names) {
    const id = newTenantId();
    const applicationKey = mintBearerToken();
    const principalId = `principal_${randomBytes(8).toString("hex")}`;
    await module.create({
      tenantId: id,
      name,
      principalId,
      credentialHash: hashToken(applicationKey),
      idempotencyKey: `sec-${id}`,
    });
    const tenantPath = tenantPaths(hostRoot, id);
    if (!existsSync(tenantPath.kek)) createKekFile(tenantPath.kek);
    tenants.push({
      id,
      name,
      applicationKey,
      principalId,
      paths: tenantPath,
      headers(key?: string) {
        return tenantHeaders(id, key ?? applicationKey);
      },
    });
  }

  const host = createHost({
    hostRoot,
    module,
    config,
    credentials,
    logger: hostLogger,
    coreVersion: "0.4.0-test",
  });
  await host.listen();

  const handle: SecurityHost = {
    url: host.url,
    hostRoot,
    adminKey,
    hostId,
    module,
    host,
    tenants,
    hostLogLines,
    ambientHome,
    async close() {
      await host.close();
      await module.close();
      if (!options?.retainRoot) {
        await rm(hostRoot, { recursive: true, force: true });
        await rm(ambientHome, { recursive: true, force: true });
      }
    },
  };
  live.push(handle);
  return handle;
}

export function readTenantLog(tenant: SecurityTenant): string {
  if (!existsSync(tenant.paths.log)) return "";
  return readFileSync(tenant.paths.log, "utf8");
}

/** Row counts of a Tenant database, read through a read-only SQLite Session Store. */
export async function countSqliteRows(
  databasePath: string,
  table: "definitions" | "sessions",
): Promise<number> {
  const store = createSqliteSessionStore({
    path: databasePath,
    tenantId: "count",
    readOnly: true,
  });
  try {
    return (await store.tx((t) => t.counts()))[table];
  } finally {
    await store.close();
  }
}
