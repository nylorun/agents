import { afterEach, expect, it } from "vitest";
import { createSqliteSessionStore } from "../src/store/sqlite.js";
import { join } from "node:path";
import { startTestTenant } from "./support/tenant.js";
import { hashToken } from "../src/core/executors.js";

const APP = "server-token-value-aaaaaaaa"; // ≥16 chars; used as application key in tests
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
});

async function host(
  options: {
    executors?: {
      token: string;
      agentId: string;
      implementationVersion: string;
    }[];
    hostRoot?: string;
    tenantId?: string;
    applicationKey?: string;
    principalId?: string;
    retainRoot?: boolean;
  } = {},
) {
  const runtime = await startTestTenant({
    applicationKey: options.applicationKey ?? APP,
    ...(options.principalId ? { principalId: options.principalId } : {}),
    ...(options.hostRoot ? { hostRoot: options.hostRoot } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.retainRoot ? { retainRoot: true } : {}),
    executors: options.executors ?? [],
    modelProvider: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });
  live.push(runtime);
  return runtime;
}

const register = (url: string, body: unknown, key = APP) =>
  fetch(`${url}/v1/executors`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const one = (token: string, agentId = "issue") => ({
  executors: [{ token, agentId, implementationVersion: "dev" }],
});

const connect = (url: string, token: string) =>
  fetch(`${url}/v1/executors/connect`, {
    headers: { authorization: `Bearer ${token}` },
  });

it("registers an executor that can immediately open the work stream", async () => {
  const runtime = await host();
  const response = await register(runtime.url, one("registered-token-value"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    executors: [
      { agentId: "issue", implementationVersion: "dev", rotated: false },
    ],
  });
  const stream = await connect(runtime.url, "registered-token-value");
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
});

it("requires the application credential", async () => {
  const runtime = await host({
    executors: [
      {
        token: "executor-token-value",
        agentId: "issue",
        implementationVersion: "dev",
      },
    ],
  });
  expect(
    (await register(runtime.url, one("another-token-value"), "executor-token-value"))
      .status,
  ).toBe(403);
  expect(
    (await register(runtime.url, one("another-token-value"), "wrong-token-value"))
      .status,
  ).toBe(404);
  expect(
    (await fetch(`${runtime.url}/v1/executors`, { method: "PUT", body: "{}" }))
      .status,
  ).toBe(404);
});

it("rejects credentials that are weak, shared with the application, or duplicated", async () => {
  const runtime = await host();
  expect((await register(runtime.url, one("short"))).status).toBe(400);
  expect((await register(runtime.url, one(APP))).status).toBe(400);
  const duplicate = await register(runtime.url, {
    executors: [
      {
        token: "shared-token-value-a",
        agentId: "one",
        implementationVersion: "dev",
      },
      {
        token: "shared-token-value-a",
        agentId: "two",
        implementationVersion: "dev",
      },
    ],
  });
  expect(duplicate.status).toBe(400);
  const listed = await fetch(`${runtime.url}/v1/executors`, {
    headers: { authorization: `Bearer ${APP}` },
  });
  expect((await listed.json()).executors).toEqual([]);
});

it("treats an unchanged registration as idempotent and leaves the stream open", async () => {
  const runtime = await host();
  await register(runtime.url, one("registered-token-value"));
  const stream = await connect(runtime.url, "registered-token-value");
  const reader = stream.body!.getReader();
  await reader.read();
  const again = await register(runtime.url, one("registered-token-value"));
  expect((await again.json()).executors[0].rotated).toBe(false);
  await register(runtime.url, one("registered-token-value"));
  expect((await connect(runtime.url, "registered-token-value")).status).toBe(
    200,
  );
  await reader.cancel();
});

it("drops the replaced stream and invalidates the old token on rotation", async () => {
  const runtime = await host();
  await register(runtime.url, one("first-token-value-aaa"));
  const stream = await connect(runtime.url, "first-token-value-aaa");
  const reader = stream.body!.getReader();
  await reader.read();
  const rotated = await register(runtime.url, one("second-token-value-bb"));
  expect((await rotated.json()).executors[0].rotated).toBe(true);
  let done = false;
  for (let i = 0; i < 40 && !done; i++) done = (await reader.read()).done;
  expect(done).toBe(true);
  expect((await connect(runtime.url, "first-token-value-aaa")).status).toBe(
    404,
  );
  expect((await connect(runtime.url, "second-token-value-bb")).status).toBe(
    200,
  );
});

it("does not treat a PUT to the connect route as a registration", async () => {
  const runtime = await host();
  const response = await fetch(`${runtime.url}/v1/executors/connect`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${APP}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(one("registered-token-value")),
  });
  expect(response.status).toBe(404);
});

it("deletes a registered executor", async () => {
  const runtime = await host();
  await register(runtime.url, one("registered-token-value"));
  await register(runtime.url, {
    executors: [
      {
        token: "seeded-token-valueee",
        agentId: "seeded",
        implementationVersion: "dev",
      },
    ],
  });
  const remove = (agentId: string) =>
    fetch(`${runtime.url}/v1/executors/${agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${APP}` },
    });
  expect((await remove("issue")).status).toBe(200);
  expect((await connect(runtime.url, "registered-token-value")).status).toBe(
    404,
  );
  expect((await remove("issue")).status).toBe(404);
  expect((await remove("seeded")).status).toBe(200);
});

it("keeps registrations across a restart and hashes tokens at rest", async () => {
  const first = await host({ retainRoot: true });
  await register(first.url, one("persisted-token-value"));
  const { root, tenantId, applicationKey, principalId } = first;
  await first.close();
  live.length = 0;

  const database = createSqliteSessionStore({
    path: join(root, "tenants", tenantId, "tenant.sqlite"),
    tenantId,
  });
  const rows = await database.tx((t) => t.listExecutors());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tokenHash).not.toBe("persisted-token-value");
  expect(rows[0]!.tokenHash).toBe(hashToken("persisted-token-value"));
  await database.close();

  const restarted = await host({
    hostRoot: root,
    tenantId,
    applicationKey,
    principalId,
  });
  expect(
    (await connect(restarted.url, "persisted-token-value")).status,
  ).toBe(200);
});

it("records replacedBy when a different application principal re-registers", async () => {
  const first = await host({ retainRoot: true });
  await register(first.url, one("shared-agent-token-aa"));
  const { root, tenantId } = first;
  await first.close();
  live.length = 0;

  const otherKey = "other-application-keybbb";
  const restarted = await startTestTenant({
    hostRoot: root,
    tenantId,
    applicationKey: otherKey,
    principalId: "principal_other",
    // Principal already exists from first boot; open existing DB without re-bootstrap.
    // Bootstrap only runs when DB is missing; here DB exists so we need the OTHER
    // principal in the DB. Insert via a second principal for this test.
    modelProvider: async () => ({ output: [{ type: "text", text: "ok" }] }),
    retainRoot: false,
  });
  // Existing DB has only the first principal; otherKey will 404. Seed second principal.
  await restarted.close();

  const db = createSqliteSessionStore({
    path: join(root, "tenants", tenantId, "tenant.sqlite"),
    tenantId,
  });
  const { bootstrapPrincipal } = await import("../src/tenant/principals.js");
  await db.tx((t) =>
    bootstrapPrincipal(t, {
      principalId: "principal_other",
      credentialHash: hashToken(otherKey),
      idempotencyKey: "other-boot",
    }),
  );
  await db.close();

  const again = await host({
    hostRoot: root,
    tenantId,
    applicationKey: otherKey,
    principalId: "principal_other",
  });
  const response = await register(again.url, one("shared-agent-token-aa"), otherKey);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    executors: [
      {
        agentId: "issue",
        implementationVersion: "dev",
        rotated: false,
        replacedBy: "different-credential",
      },
    ],
  });
});

it("never discloses tokens through the executor listing", async () => {
  const runtime = await host();
  await register(runtime.url, one("registered-token-value"));
  const response = await fetch(`${runtime.url}/v1/executors`, {
    headers: { authorization: `Bearer ${APP}` },
  });
  const text = await response.text();
  expect(text).not.toContain("registered-token-value");
  expect(text).not.toContain("tokenHash");
  expect(JSON.parse(text).executors).toEqual([
    {
      agentId: "issue",
      implementationVersion: "dev",
      connected: false,
      updatedAt: expect.any(String),
    },
  ]);
});
