import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createHost,
  type CreateHostOptions,
  type HostServer,
} from "../../src/host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../../src/host/config.js";
import { createHostLogger } from "../../src/host/logger.js";
import type {
  BootstrapPrincipal,
  Quarantine,
  TenantHandle,
  TenantModule,
  TenantResolution,
  TenantSummary,
} from "../../src/tenant/types.js";

export const ADMIN_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const roots: string[] = [];
const live: HostServer[] = [];

afterEach(async () => {
  for (const host of live.splice(0)) await host.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export function protocolHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...extra,
  };
}

export function adminHeaders(
  key: string = ADMIN_KEY,
): Record<string, string> {
  return protocolHeaders({
    authorization: `Bearer ${key}`,
  });
}

export function tenantHeaders(
  tenantId: string,
  key = "application-key-value-16",
): Record<string, string> {
  return protocolHeaders({
    [TENANT_HEADER]: tenantId,
    authorization: `Bearer ${key}`,
  });
}

export interface FakeTenant {
  id: string;
  name: string;
  state: "open" | "quarantined";
  quarantine?: Quarantine;
  handle?: TenantHandle;
  summary?: TenantSummary;
}

export function createFakeModule(options?: {
  tenants?: FakeTenant[];
  startDelayMs?: number;
  onStart?: () => void | Promise<void>;
}): TenantModule & {
  tenants: Map<string, FakeTenant>;
  createCalls: unknown[];
  deleteCalls: { id: string; activeWork: string }[];
} {
  const tenants = new Map<string, FakeTenant>(
    (options?.tenants ?? []).map((t) => [t.id, t]),
  );
  let started = false;
  const createCalls: unknown[] = [];
  const deleteCalls: { id: string; activeWork: string }[] = [];

  const envelopeOf = (t: FakeTenant): TenantEnvelope => ({
    id: t.id,
    name: t.name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  });

  const defaultHandle = (tenantId: string): TenantHandle => ({
    envelope: envelopeOf({
      id: tenantId,
      name: "t",
      state: "open",
    }),
    async handle(
      _request: IncomingMessage,
      response: ServerResponse,
      _url: URL,
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, tenantId }));
    },
    async summary(): Promise<TenantSummary> {
      return {
        ready: true,
        runningSessions: 0,
        connectedExecutors: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      };
    },
    async drain() {},
    async close() {},
  });

  return {
    tenants,
    createCalls,
    deleteCalls,
    async start() {
      if (options?.startDelayMs) {
        await new Promise((r) => setTimeout(r, options.startDelayMs));
      }
      await options?.onStart?.();
      started = true;
    },
    get started() {
      return started;
    },
    async resolve(id: string): Promise<TenantResolution> {
      const t = tenants.get(id);
      if (!t) return { kind: "not-found" };
      if (t.state === "quarantined") {
        return {
          kind: "quarantined",
          quarantine: t.quarantine ?? {
            code: "open-failed",
            message: "quarantined",
            repair: "nylo tenant status",
          },
        };
      }
      return {
        kind: "open",
        handle: t.handle ?? defaultHandle(id),
      };
    },
    async worker(id: string) {
      const t = tenants.get(id);
      return t?.state === "open" ? t.handle?.worker : undefined;
    },
    async create(
      input: { tenantId: string; name: string } & BootstrapPrincipal,
    ) {
      createCalls.push(input);
      const existing = tenants.get(input.tenantId);
      if (existing) {
        throw Object.assign(new Error("Tenant already exists"), {
          code: "conflict",
        });
      }
      const fake: FakeTenant = {
        id: input.tenantId,
        name: input.name,
        state: "open",
      };
      tenants.set(input.tenantId, fake);
      return { envelope: envelopeOf(fake), created: true };
    },
    async list(): Promise<readonly AdminTenant[]> {
      return [...tenants.values()].map((t) => ({
        id: t.id,
        name: t.name,
        state: t.state,
        envelope: t.state === "open" ? envelopeOf(t) : null,
      }));
    },
    async status(id: string): Promise<AdminTenantStatus | undefined> {
      const t = tenants.get(id);
      if (!t) return undefined;
      return {
        id: t.id,
        name: t.name,
        state: t.state,
        envelope: t.state === "open" ? envelopeOf(t) : null,
        quarantine: t.quarantine,
      };
    },
    async delete(id: string, activeWork: "refuse" | "drain" | "cancel") {
      deleteCalls.push({ id, activeWork });
      const t = tenants.get(id);
      if (!t) return;
      const work = t.summary?.runningSessions ?? 0;
      if (work > 0 && activeWork === "refuse") {
        throw Object.assign(new Error("Active work"), { code: "active_work" });
      }
      tenants.delete(id);
    },
    async summarize(): Promise<HostAggregate> {
      let runningSessions = 0;
      let connectedExecutors = 0;
      let pendingActions = 0;
      let uncertainEffects = 0;
      for (const t of tenants.values()) {
        const s = t.summary ?? (await t.handle?.summary());
        if (!s) continue;
        runningSessions += s.runningSessions;
        connectedExecutors += s.connectedExecutors;
        pendingActions += s.pendingActions;
        uncertainEffects += s.uncertainEffects;
      }
      return {
        runningSessions,
        connectedExecutors,
        pendingActions,
        uncertainEffects,
      };
    },
    async close() {
      started = false;
    },
  };
}

export async function startTestHost(
  overrides?: Partial<CreateHostOptions> & {
    module?: TenantModule;
    port?: number;
    host?: string;
    allowNonLoopback?: boolean;
    logLines?: string[];
  },
): Promise<{
  host: HostServer;
  url: string;
  root: string;
  module: ReturnType<typeof createFakeModule> | TenantModule;
  config: HostConfigFile;
  credentials: HostCredentialsFile;
}> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-host-"));
  roots.push(root);
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(join(root, "tenants"), { recursive: true });

  const port = overrides?.port ?? (await freePort());
  const config: HostConfigFile = {
    hostId: "host_0123456789abcdefghjkmnpq",
    host: overrides?.host ?? "127.0.0.1",
    port,
    allowNonLoopback: overrides?.allowNonLoopback,
    proxy: { httpsProxy: "http://proxy.test:8080" },
  };
  const credentials: HostCredentialsFile = { adminKey: ADMIN_KEY };
  await writeFile(join(root, "host.json"), JSON.stringify(config));
  await writeFile(
    join(root, "host-credentials.json"),
    JSON.stringify(credentials),
  );

  const module = overrides?.module ?? createFakeModule();
  const logLines = overrides?.logLines;
  const logger =
    overrides?.logger ??
    createHostLogger(logLines ? (line) => logLines.push(line) : () => {});

  const host = createHost({
    hostRoot: root,
    module,
    config,
    credentials,
    logger,
    coreVersion: "0.4.0-beta",
    ...overrides,
    // re-apply after spread so explicit module/config win
    module,
    config,
    credentials,
    logger,
  });
  await host.listen();
  live.push(host);
  return {
    host,
    url: host.url,
    root,
    module,
    config,
    credentials,
  };
}

export async function getJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  return { status: response.status, body, headers: response.headers };
}

export { newTenantId, HOST_PROTOCOL, PROTOCOL_HEADER, TENANT_HEADER };
