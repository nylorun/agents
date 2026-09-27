/**
 * `startEphemeralRuntime` (`tenant/ephemeral.ts`): an in-process Host whose Tenants live in
 * memory. It runs turns, creates and deletes Tenants through the Admin API, and leaves no
 * session data under its Host root.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { Agent } from "@nylorun/core/define";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { until } from "../host/execution-support.js";

const roots: string[] = [];
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const bot = Agent({ id: "bot", name: "Bot" }).build();

it("runs a turn on a Tenant kept in memory and removes its Host root on close", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
  roots.push(hostRoot);
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    model: { kind: "scripted", output: "hello from memory" },
  });
  const headers = {
    authorization: `Bearer ${runtime.applicationKey}`,
    [TENANT_HEADER]: runtime.tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  };
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${runtime.url}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(
    (
      await call("/v1/agents/bot", "PUT", {
        requestId: "put-bot",
        manifest: bot.manifest,
        implementationVersion: "dev",
      })
    ).ok
  ).toBe(true);
  expect(
    (await call("/v1/sessions/s1", "PUT", { requestId: "s1", agentId: "bot", ownerUserId: "u" }))
      .ok
  ).toBe(true);
  expect(
    (
      await call("/v1/sessions/s1/commands", "POST", {
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "hi",
      })
    ).ok
  ).toBe(true);
  const items = await until(
    async () =>
      ((await (await call("/v1/sessions/s1/items")).json()) as { items: { type: string }[] })
        .items,
    (list) => list.some((item) => item.type === "turn.completed"),
    "turn.completed"
  );
  expect(JSON.stringify(items)).toContain("hello from memory");

  // No Session Store file anywhere under the Host root.
  const files = readdirSync(hostRoot, { recursive: true }).map(String);
  expect(files.filter((file) => /sqlite|\.db$/.test(file))).toEqual([]);

  await runtime.close();
  expect(existsSync(hostRoot)).toBe(false);
});

it("creates and deletes more Tenants through the Admin API", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
  roots.push(hostRoot);
  const runtime = await startEphemeralRuntime({ hostRoot });
  closers.push(runtime);
  const admin = {
    authorization: `Bearer ${runtime.adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  };
  const key = randomBytes(32).toString("hex");
  const tenantId = newTenantId();
  const created = await fetch(`${runtime.url}/v1/admin/tenants`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      tenantId,
      name: "second",
      principalId: `principal_${randomBytes(4).toString("hex")}`,
      credentialHash: createHash("sha256").update(key).digest("hex"),
      idempotencyKey: randomUUID(),
    }),
  });
  expect(created.status).toBe(201);
  const status = await fetch(`${runtime.url}/v1/tenant`, {
    headers: {
      authorization: `Bearer ${key}`,
      [TENANT_HEADER]: tenantId,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
  });
  expect(status.status).toBe(200);

  const deleted = await fetch(`${runtime.url}/v1/admin/tenants/${tenantId}?activeWork=cancel`, {
    method: "DELETE",
    headers: admin,
  });
  expect(deleted.ok).toBe(true);
  const gone = await fetch(`${runtime.url}/v1/admin/tenants/${tenantId}`, { headers: admin });
  expect(gone.status).toBe(404);
});
