import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import {
  SeedTenantConfigResponseSchema,
  TenantStatusSchema,
} from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";
import { startEphemeralRuntime } from "../src/tenant/ephemeral.js";
import { testPool } from "./support/store.js";

const roots: string[] = [];
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const agentReset = Agent({ id: "agent-reset", name: "Reset" }).build();
const agentAll = Agent({ id: "agent-all", name: "All" }).build();

it("GET /v1/tenant returns TenantStatusSchema with secrets redacted (A14)", async () => {
  const runtime = await startTestTenant({
    applicationKey: "status-app-key-16chars",
  });
  closers.push(runtime);

  const response = await fetch(`${runtime.url}/v1/tenant`, {
    headers: runtime.managementHeaders(),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const parsed = TenantStatusSchema.parse(body);
  expect(parsed.tenant.id).toBe(runtime.tenantId);
  expect(parsed.path).toMatch(/\/tenant$/);
  expect(parsed.checks.store).toBe(true);
  expect(parsed.checks.schema).toBe(true);
  expect(parsed.model.configured).toBe(false);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("status-app-key-16chars");
  expect(serialized).not.toContain(runtime.managementKey);
});

it("summary() returns counts only with no string fields (A15)", async () => {
  const runtime = await startTestTenant();
  closers.push(runtime);
  const summary = await runtime.handle.summary();
  expect(summary).toEqual({
    ready: true,
    runningSessions: 0,
    inFlightDeliveries: 0,
    pendingActions: 0,
    uncertainEffects: 0,
    harness: { mode: expect.any(String), connected: 1, workspace: expect.any(Boolean) },
  });
  for (const [key, value] of Object.entries(summary)) {
    expect(typeof value, key).not.toBe("string");
  }
});

it("drain(cancel) stops scheduling and clears running work (A16)", async () => {
  const runtime = await startTestTenant();
  closers.push(runtime);
  await runtime.handle.drain("cancel", 1_000);
  const summary = await runtime.handle.summary();
  expect(summary.ready).toBe(false);
  expect(summary.runningSessions).toBe(0);
});

it("POST /v1/tenant/reset sessions preserves principals and clears sessions (A17)", async () => {
  const runtime = await startTestTenant({
    applicationKey: "reset-app-key-16chars!",
  });
  closers.push(runtime);

  const putAgent = await fetch(
    `${runtime.url}/v1/agents/${agentReset.manifest.id}`,
    {
      method: "PUT",
      headers: runtime.headers(),
      body: JSON.stringify({
        requestId: randomUUID(),
        implementationVersion: "dev",
        manifest: agentReset.manifest,
      }),
    },
  );
  expect(putAgent.status).toBe(200);

  const session = await fetch(`${runtime.url}/v1/sessions/sess-reset`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({
      requestId: randomUUID(),
      agentId: agentReset.manifest.id,
      ownerUserId: "user-1",
    }),
  });
  expect(session.status).toBe(200);

  const reset = await fetch(`${runtime.url}/v1/tenant/reset`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      scope: "sessions",
      activeWork: "cancel",
    }),
  });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({ ok: true });

  const missing = await fetch(`${runtime.url}/v1/sessions/sess-reset`, {
    headers: runtime.headers(),
  });
  expect(missing.status).toBe(404);

  const status = await fetch(`${runtime.url}/v1/tenant`, {
    headers: runtime.managementHeaders(),
  });
  const body = TenantStatusSchema.parse(await status.json());
  expect(body.counts.sessions).toBe(0);
  expect(
    body.agents.some(
      (a) => a.agentId === agentReset.manifest.id && a.registered,
    ),
  ).toBe(true);
  expect(
    (
      await fetch(`${runtime.url}/v1/tenant`, {
        headers: runtime.managementHeaders(),
      })
    ).status,
  ).toBe(200);
});

it("PUT /v1/tenant/config/seed is insert-if-absent (A18)", async () => {
  const runtime = await startTestTenant({
    applicationKey: "seed-app-key-16chars!!",
  });
  closers.push(runtime);

  const first = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      sandbox: { backend: "virtual" },
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        auth: { type: "api_key", key: "sk-seed-secret-value" },
      },
    }),
  });
  expect(first.status).toBe(200);
  const applied = SeedTenantConfigResponseSchema.parse(await first.json());
  expect(applied.applied.sort()).toEqual(["model", "sandbox.backend"]);
  expect(applied.kept).toEqual([]);

  const second = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      sandbox: { backend: "auto" },
      model: {
        provider: "anthropic",
        model: "claude",
        auth: { type: "api_key", key: "sk-other-secret" },
      },
    }),
  });
  expect(second.status).toBe(200);
  const kept = SeedTenantConfigResponseSchema.parse(await second.json());
  expect(kept.applied).toEqual([]);
  expect(kept.kept.sort()).toEqual(["model", "sandbox.backend"]);

  const model = await fetch(`${runtime.url}/v1/tenant/model`, {
    headers: runtime.managementHeaders(),
  });
  const modelBody = await model.json();
  expect(modelBody).toMatchObject({
    configured: true,
    provider: "openai",
    model: "gpt-4o-mini",
  });
  expect(JSON.stringify(modelBody)).not.toContain("sk-seed-secret-value");
});

it("startEphemeralRuntime opens a private Host with one Tenant (A19)", async () => {
  const hostRoot = await tempRoot("ephemeral-host-");
  const runtime = await startEphemeralRuntime({
    database: testPool(),
    hostRoot,
  });
  closers.push(runtime);

  const health = await fetch(`${runtime.url}/health`);
  expect(health.status).toBe(200);
  const ready = await fetch(`${runtime.url}/ready`);
  expect(ready.status).toBe(200);
  expect(runtime.tenantId).toMatch(/^tn_/);
  expect(runtime.applicationKey.length).toBeGreaterThanOrEqual(16);
  expect(runtime.managementKey.length).toBeGreaterThanOrEqual(16);
  expect(runtime.adminKey.length).toBeGreaterThanOrEqual(16);

  const status = await fetch(`${runtime.url}/v1/tenant`, {
    headers: {
      authorization: `Bearer ${runtime.managementKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "content-type": "application/json",
    },
  });
  expect(status.status).toBe(200);
  TenantStatusSchema.parse(await status.json());
});

it("reset sandboxes renames then clears the sandboxes directory (A17)", async () => {
  const runtime = await startTestTenant();
  closers.push(runtime);
  const sandboxes = join(runtime.root, "tenant", "sandboxes");
  writeFileSync(join(sandboxes, "marker.txt"), "keep-me-not");

  const reset = await fetch(`${runtime.url}/v1/tenant/reset`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      scope: "sandboxes",
      activeWork: "drain",
    }),
  });
  expect(reset.status).toBe(200);
  expect(existsSync(join(sandboxes, "marker.txt"))).toBe(false);
  expect(existsSync(sandboxes)).toBe(true);
});

it("reset all clears definitions, Action endpoints, user vaults and tenant log (A17)", async () => {
  const runtime = await startTestTenant({
    applicationKey: "reset-all-key-16chars",
    endpoints: [
      {
        agentId: agentAll.manifest.id,
        url: "http://127.0.0.1:9/actions",
        implementationVersion: "dev",
      },
    ],
  });
  closers.push(runtime);

  await fetch(`${runtime.url}/v1/agents/${agentAll.manifest.id}`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: agentAll.manifest,
    }),
  });

  const vault = await fetch(`${runtime.url}/v1/tenant/vaults`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      idempotencyKey: "vault-1",
      name: "user-vault",
      ownerUserId: "user-1",
    }),
  });
  expect(vault.status).toBe(200);

  await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        auth: { type: "api_key", key: "sk-keep-host-model" },
      },
    }),
  });

  const logPath = join(runtime.root, "tenant", "logs", "tenant.log");
  writeFileSync(logPath, '{"level":"info","message":"noise"}\n');
  expect(existsSync(logPath)).toBe(true);

  const endpoints = async () =>
    (
      await (
        await fetch(`${runtime.url}/v1/endpoints`, { headers: runtime.headers() })
      ).json()
    ).endpoints as { agentId: string }[];
  expect((await endpoints()).map((endpoint) => endpoint.agentId)).toEqual([
    agentAll.manifest.id,
  ]);

  const reset = await fetch(`${runtime.url}/v1/tenant/reset`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      scope: "all",
      activeWork: "cancel",
    }),
  });
  expect(reset.status).toBe(200);

  const status = TenantStatusSchema.parse(
    await (
      await fetch(`${runtime.url}/v1/tenant`, { headers: runtime.managementHeaders() })
    ).json(),
  );
  expect(status.agents).toEqual([]);
  expect(status.counts.sessions).toBe(0);
  expect(status.model.configured).toBe(true);
  expect(await endpoints()).toEqual([]);

  const vaults = await fetch(`${runtime.url}/v1/tenant/vaults?ownerUserId=user-1`, {
    headers: runtime.managementHeaders(),
  });
  expect((await vaults.json()).vaults).toEqual([]);

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  expect(log).toBe("");
});
