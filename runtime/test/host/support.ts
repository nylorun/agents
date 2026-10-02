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
  HostAggregate,
  HostTenant,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import {
  createHost,
  type CreateHostOptions,
  type HostServer,
} from "../../src/host/create-host.js";
import type { HostConfigFile, HostCredentialsFile } from "../../src/host/config.js";
import { createHostLogger } from "../../src/host/logger.js";
import type { TenantCause } from "../../src/tenant/cause.js";
import type {
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

/**
 * A Tenant request's headers: protocol 5 names no Tenant. `tenant` adds `Nylorun-Tenant`, as
 * a protocol 4 client sends it.
 */
export function tenantHeaders(
  key = "application-key-value-16",
  tenant?: string,
): Record<string, string> {
  return protocolHeaders({
    ...(tenant === undefined ? {} : { [TENANT_HEADER]: tenant }),
    authorization: `Bearer ${key}`,
  });
}

/** The id of the fake module's Tenant. */
export const FAKE_TENANT_ID = "tn_0123456789abcdefghjkmnpqrs";

export interface FakeTenant {
  id: string;
  name: string;
  state: "open" | "unavailable";
  cause?: TenantCause;
  handle?: TenantHandle;
  summary?: TenantSummary;
}

/** A Tenant module serving one fake Tenant (open by default). */
export function createFakeModule(options?: {
  tenant?: Partial<FakeTenant>;
  startDelayMs?: number;
  onStart?: () => void | Promise<void>;
}): TenantModule & { fake: FakeTenant } {
  const fake: FakeTenant = {
    id: FAKE_TENANT_ID,
    name: "t",
    state: "open",
    ...options?.tenant,
  };
  let ready = false;
  let closed = false;

  const envelopeOf = (t: FakeTenant): TenantEnvelope => ({
    id: t.id,
    name: t.name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  });

  const defaultHandle = (): TenantHandle => ({
    envelope: envelopeOf(fake),
    async fetch() {
      return new Response(JSON.stringify({ ok: true, tenantId: fake.id }), {
        headers: { "content-type": "application/json" },
      });
    },
    async summary(): Promise<TenantSummary> {
      return {
        ready: true,
        runningSessions: 0,
        inFlightDeliveries: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      };
    },
    async drain() {},
    async close() {},
  });

  return {
    fake,
    async start() {
      if (options?.startDelayMs) {
        await new Promise((r) => setTimeout(r, options.startDelayMs));
      }
      await options?.onStart?.();
      ready = fake.state === "open";
    },
    get ready() {
      return ready && !closed;
    },
    async resolve(): Promise<TenantResolution> {
      if (closed) return { kind: "unavailable" };
      if (fake.state === "unavailable")
        return { kind: "unavailable", ...(fake.cause ? { cause: fake.cause } : {}) };
      return { kind: "open", handle: fake.handle ?? defaultHandle() };
    },
    async worker(id: string) {
      return fake.state === "open" && id === fake.id ? fake.handle?.worker : undefined;
    },
    tenant(): HostTenant {
      if (fake.state === "open")
        return { id: fake.id, name: fake.name, state: "open", envelope: envelopeOf(fake) };
      return {
        id: fake.id,
        name: fake.name,
        state: "unavailable",
        envelope: envelopeOf(fake),
        ...(fake.cause ? { cause: fake.cause } : {}),
      };
    },
    async summarize(): Promise<HostAggregate> {
      const s = fake.summary ?? (fake.state === "open" ? await fake.handle?.summary() : undefined);
      return {
        runningSessions: s?.runningSessions ?? 0,
        inFlightDeliveries: s?.inFlightDeliveries ?? 0,
        pendingActions: s?.pendingActions ?? 0,
        uncertainEffects: s?.uncertainEffects ?? 0,
      };
    },
    async close() {
      closed = true;
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
  module: TenantModule;
  config: HostConfigFile;
  credentials: HostCredentialsFile;
}> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-host-"));
  roots.push(root);
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });

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
