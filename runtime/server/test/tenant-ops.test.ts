import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import {
  SeedTenantConfigResponseSchema,
  TenantStatusSchema,
} from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
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

  await deploy(runtime.url, runtime.headers(), agentReset);
  const session = await openSession(runtime.url, runtime.headers(), "sess-reset", {
    agent: agentReset.manifest.id,
    ownerUserId: "user-1",
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
      (a) => a.agentId === agentReset.manifest.id,
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

it("reset agents deletes the Agents, then renames and clears the sandboxes directory (A17)", async () => {
  const runtime = await startTestTenant();
  closers.push(runtime);
  const sandboxes = join(runtime.root, "tenant", "sandboxes");
  writeFileSync(join(sandboxes, "marker.txt"), "keep-me-not");
  await deploy(runtime.url, runtime.headers(), agentReset, { id: "e1", runtime: { kind: "virtual" } });

  // The protocol 10 and 11 scopes are refused, not read as another.
  for (const scope of ["sandboxes", "environments"]) {
    const old = await fetch(`${runtime.url}/v1/tenant/reset`, {
      method: "POST",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ requestId: randomUUID(), scope, activeWork: "drain" }),
    });
    expect(old.status, scope).toBe(400);
  }
  expect(existsSync(join(sandboxes, "marker.txt"))).toBe(true);

  const reset = await fetch(`${runtime.url}/v1/tenant/reset`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: randomUUID(),
      scope: "agents",
      activeWork: "drain",
    }),
  });
  expect(reset.status).toBe(200);
  expect(existsSync(join(sandboxes, "marker.txt"))).toBe(false);
  expect(existsSync(sandboxes)).toBe(true);
  expect((await fetch(`${runtime.url}/v1/agents/e1`, { headers: runtime.headers() })).status).toBe(404);
  // The manifest it was made from stays.
  expect((await fetch(`${runtime.url}/v1/agent-manifests/agent-reset`, { headers: runtime.headers() })).status).toBe(200);
});

it("reset all clears agent manifests, Agents with their secrets, and tenant log (A17)", async () => {
  const runtime = await startTestTenant({ applicationKey: "reset-all-key-16chars" });
  closers.push(runtime);

  // Agent user-1, of kind none, guarded for its owner.
  const agent = await deploy(runtime.url, runtime.headers(), agentAll, { id: "user-1", owner: "user-1" });
  expect(agent).toMatchObject({ kind: "none", owner: "user-1" });
  const secret = await fetch(`${runtime.url}/v1/agents/user-1/secrets/api`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({
      requestId: randomUUID(),
      type: "bearer",
      url: "https://api.example.com",
      value: "user-1-token",
    }),
  });
  expect(secret.status).toBe(200);

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

  const agents = await fetch(`${runtime.url}/v1/agents`, {
    headers: runtime.headers(),
  });
  expect((await agents.json()).agents).toEqual([]);
  expect(
    (await fetch(`${runtime.url}/v1/agents/user-1/secrets/api`, { headers: runtime.headers() })).status,
  ).toBe(404);
  const manifests = await fetch(`${runtime.url}/v1/agent-manifests`, { headers: runtime.headers() });
  expect((await manifests.json()).manifests).toEqual([]);

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  expect(log).toBe("");
});
