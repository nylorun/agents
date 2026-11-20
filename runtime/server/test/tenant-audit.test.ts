/**
 * The Tenant's stream (ADR-159, Host feature `tenant-audit`): each key put and delete, signing-key
 * rotation and revocation, tool policy and setting change, and vault credential write and use
 * records one event, in the change's transaction, naming the principal of the request's
 * credential and never a secret. `GET /v1/tenant/audit` pages them newest first, filters by type
 * and time, and takes only a management key; `POST /v1/tenant/audit/studio-sign-in` takes only
 * Studio's key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createManagementClient } from "@nylorun/admin";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { TenantAuditPageSchema, type TenantEvent } from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { runOperate } from "../src/host/operate.js";
import { startEphemeralRuntime } from "../src/tenant/ephemeral.js";
import { deriveStudioKey } from "../src/tenant/principals.js";
import { manifestOf, saveManifest } from "./support/agents.js";
import { isolatedTestDatabase } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** An ephemeral Runtime with a management key `ops` (from `nylorun-operate`) and Studio's key. */
async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-audit-"));
  const database = await isolatedTestDatabase();
  const adminKey = "a".repeat(64);
  const runtime = await startEphemeralRuntime({ hostRoot, retainRoot: true, database: database.sql, adminKey });
  open.push(
    () => rm(hostRoot, { recursive: true, force: true }),
    database.drop,
    () => runtime.close(),
  );
  const out: string[] = [];
  const code = await runOperate(["keys", "put", "ops", "--role", "management"], {
    env: { NYLORUN_DATABASE_URL: database.url },
    out: (line) => out.push(line),
    err: () => undefined,
  });
  expect(code).toBe(0);
  const opsKey = out[0]!;
  const admin = createManagementClient({ url: runtime.url, key: opsKey });
  const send = async (key: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  };
  return { ...runtime, admin, opsKey, studioKey: deriveStudioKey(adminKey), send };
}

/** Every event of the Tenant's stream, oldest first, read page by page. */
async function allEvents(admin: ReturnType<typeof createManagementClient>, types?: string[]): Promise<TenantEvent[]> {
  const events: TenantEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await admin.tenant.audit({ limit: 2, ...(types ? { types } : {}), ...(cursor ? { cursor } : {}) });
    events.push(...page.events);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events.reverse();
}

describe("the Tenant's stream", () => {
  it("records a key put and a key delete as the management key, never the key", async () => {
    const host = await startHost();
    const put = await host.admin.keys.put("backend");
    const rotated = await host.admin.keys.put("backend");
    expect(await host.admin.keys.delete("backend")).toBe(true);
    // A refused put and a delete of nothing record nothing.
    await expect(host.admin.keys.put("studio")).rejects.toMatchObject({ status: 400 });
    expect(await host.admin.keys.delete("backend")).toBe(false);

    const events = await allEvents(host.admin, ["key.created", "key.revoked"]);
    // `ops` itself was put by nylorun-operate, on the Tenant's machine.
    expect(events.map(({ type, principal, source, payload }) => ({ type, principal, source, payload }))).toEqual([
      { type: "key.created", principal: "operate", source: "operate", payload: { keyId: "ops", role: "management", rotated: false } },
      { type: "key.created", principal: "ops", source: "api", payload: { keyId: "backend", role: "application", rotated: false } },
      { type: "key.created", principal: "ops", source: "api", payload: { keyId: "backend", role: "application", rotated: true } },
      { type: "key.revoked", principal: "ops", source: "api", payload: { keyId: "backend", role: "application" } },
    ]);
    const text = JSON.stringify(events);
    expect(text).not.toContain(put.key);
    expect(text).not.toContain(rotated.key);
    expect(text).not.toContain(host.opsKey);
  });

  it("records signing keys rotated and revoked", async () => {
    const host = await startHost();
    const before = await host.admin.signingKeys.list();
    const rotated = await host.admin.signingKeys.rotate();
    const standby = rotated.find((key) => key.state === "standby")!;
    await host.admin.signingKeys.revoke(standby.id);
    // Revoking it again changes nothing, and records nothing.
    await host.admin.signingKeys.revoke(standby.id);
    const events = await allEvents(host.admin, ["signing_key.rotated", "signing_key.revoked"]);
    expect(events.map(({ type, principal, payload }) => ({ type, principal, payload }))).toEqual([
      {
        type: "signing_key.rotated",
        principal: "ops",
        payload: {
          current: before.find((key) => key.state === "standby")!.id,
          standby: standby.id,
          previous: before.find((key) => key.state === "current")!.id,
          force: false,
        },
      },
      { type: "signing_key.revoked", principal: "ops", payload: { keyId: standby.id, state: "standby" } },
    ]);
  });

  it("records a tool policy change by its rule count, and a setting change by its key, never a value", async () => {
    const host = await startHost();
    const policy = await host.admin.toolPolicy.put({
      rules: [
        { tool: "deploy", effect: "deny", when: { token: { equals: "policy-secret-value-31f9" } } },
        { tool: "read_*", effect: "allow" },
      ],
    });
    await host.admin.settings.limits.put({ limits: { pageItems: 150 } });
    await host.admin.models.budgets.put({ budgets: [] });
    const events = await allEvents(host.admin, ["policy.changed", "settings.changed"]);
    expect(events.map(({ type, principal, source, payload }) => ({ type, principal, source, payload }))).toEqual([
      { type: "policy.changed", principal: "ops", source: "api", payload: { rules: 2, updatedAt: policy.updatedAt } },
      { type: "settings.changed", principal: "ops", source: "api", payload: { key: "limits.config" } },
      { type: "settings.changed", principal: "ops", source: "api", payload: { key: "model.budgets" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("policy-secret-value-31f9");
    expect(JSON.stringify(events)).not.toContain("pageItems");
  });

  it("pages newest first, filters by types and time, and refuses a cursor read with other filters", async () => {
    const host = await startHost();
    for (const name of ["k1", "k2", "k3"]) await host.admin.keys.put(name);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    await pause();
    const mark = new Date().toISOString();
    await pause();
    await host.admin.keys.delete("k1");
    await host.admin.settings.limits.put({ limits: {} });

    const first = await host.admin.tenant.audit({ limit: 2 });
    expect(first.events.map((event) => event.type)).toEqual(["settings.changed", "key.revoked"]);
    expect(first.events[0]!.seq).toBeGreaterThan(first.events[1]!.seq);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await host.admin.tenant.audit({ limit: 2, cursor: first.nextCursor! });
    expect(second.events.map((event) => event.type)).toEqual(["key.created", "key.created"]);
    expect(second.events[0]!.seq).toBeLessThan(first.events[1]!.seq);
    expect(TenantAuditPageSchema.parse(second)).toEqual(second);

    const created = await host.admin.tenant.audit({ types: ["key.created"] });
    expect(created.events.map((event) => event.payload.keyId)).toEqual(["k3", "k2", "k1", "ops"]);
    expect(created.nextCursor).toBeNull();
    const since = await host.admin.tenant.audit({ since: mark });
    expect(since.events.map((event) => event.type)).toEqual(["settings.changed", "key.revoked"]);
    const until = await host.admin.tenant.audit({ until: mark, types: ["key.created", "key.revoked"] });
    expect(until.events.map((event) => event.payload.keyId)).toEqual(["k3", "k2", "k1", "ops"]);

    // A cursor belongs to its filters; an unknown type and a bad time are refused.
    await expect(
      host.admin.tenant.audit({ types: ["key.created"], cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(host.admin.tenant.audit({ types: ["session.created"] })).rejects.toMatchObject({ status: 400 });
    await expect(host.admin.tenant.audit({ since: "yesterday" })).rejects.toMatchObject({ status: 400 });
  });

  it("is read only with a management key: an application key is refused", async () => {
    const host = await startHost();
    expect((await host.send(host.opsKey, "GET", "/v1/tenant/audit")).status).toBe(200);
    // Studio's key reads it as itself, as it reads the other /v1/tenant routes.
    expect((await host.send(host.studioKey, "GET", "/v1/tenant/audit")).status).toBe(200);
    const refused = await host.send(host.applicationKey, "GET", "/v1/tenant/audit");
    expect(refused).toMatchObject({ status: 403, body: { code: "key_role_mismatch" } });
    expect((await host.send("not-a-key", "GET", "/v1/tenant/audit")).status).toBe(401);
  });
});

describe("Studio sign-ins", () => {
  it("records a sign-in with Studio's key only", async () => {
    const host = await startHost();
    const recorded = await host.send(host.studioKey, "POST", "/v1/tenant/audit/studio-sign-in", {
      method: "forwarded",
      subject: "idp:ann",
    });
    expect(recorded).toMatchObject({
      status: 201,
      body: { type: "studio.signed_in", principal: "studio", source: "studio", payload: { method: "forwarded", subject: "idp:ann" } },
    });
    expect((await host.send(host.studioKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "loopback" })).status).toBe(201);
    // Any other management key, and an application key, are refused; so is a body Studio would not send.
    expect(await host.send(host.opsKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "token" })).toMatchObject({
      status: 403,
      body: { code: "request_rejected" },
    });
    expect((await host.send(host.managementKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "token" })).status).toBe(403);
    expect((await host.send(host.applicationKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "token" })).status).toBe(403);
    expect((await host.send(host.studioKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "password" })).status).toBe(400);
    expect(
      (await host.send(host.studioKey, "POST", "/v1/tenant/audit/studio-sign-in", { method: "token", principal: "ops" })).status,
    ).toBe(400);

    const events = await allEvents(host.admin, ["studio.signed_in"]);
    expect(events.map(({ principal, payload }) => ({ principal, payload }))).toEqual([
      { principal: "studio", payload: { method: "forwarded", subject: "idp:ann" } },
      { principal: "studio", payload: { method: "loopback" } },
    ]);
  });
});

const APP = "tenant-audit-app-key-aaaaaaaaaaaaaa";
const MANAGEMENT = "tenant-audit-management-key-aaaaaa";
const TOKEN = "tenant-audit-mcp-token-5c4b3a29";

/** A remote MCP server with one `echo` tool. */
async function remoteServer() {
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const mcp = new McpServer({ name: "remote", version: "1.0.0" });
    mcp.registerTool("echo", { inputSchema: { value: z.number() } }, async ({ value }) => ({
      content: [{ type: "text" as const, text: String(value) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

/** Calls `remote__echo` once, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
  const names = (input.tools ?? []).map((tool) => tool.name);
  if (!names.includes("remote__echo") || input.prompt?.at(-1)?.kind === "tool-result")
    return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "remote__echo", args: { value: 7 } }] };
};

describe("vault credentials on the Tenant's stream", () => {
  it("records a secret written, used by a session and deleted, with its principal and no value", async () => {
    const url = await remoteServer();
    const runtime = await startTestTenant({
      applicationKey: APP,
      managementKey: MANAGEMENT,
      principalId: "backend",
      vaultKek: Buffer.alloc(32, 5).toString("base64"),
      modelProvider: model,
    });
    open.push(() => runtime.close());
    const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = server) => {
      const response = await fetch(`${runtime.url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    await saveManifest(
      runtime.url,
      server,
      manifestOf(Agent({ id: "bot", name: "Bot" }).mcp({ remote: { type: "streamable-http", url } }).build()),
    );
    expect((await call("PUT", "/v1/agents/shared", { manifest: "bot" })).status).toBe(200);
    // Written by the application key acting for a person: the event names both.
    const acting = { ...server, "nylorun-subject": "u:ann", "nylorun-scopes": "agents:write" };
    expect((await call("PUT", "/v1/agents/shared/secrets/token", { type: "bearer", url, value: TOKEN }, acting)).status).toBe(200);
    expect((await call("PUT", "/v1/sessions/s-1", { requestId: "open-1", agent: "shared", ownerUserId: "u:ann" })).status).toBe(200);
    expect(
      (await call("POST", "/v1/sessions/s-1/commands", { type: "message", requestId: "m-1", idempotencyKey: "m-1", content: "go" }))
        .status,
    ).toBe(200);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const view = await call("GET", "/v1/sessions/s-1");
      if (["completed", "failed", "uncertain"].includes(view.body.status)) {
        expect(view.body.status).toBe("completed");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await call("DELETE", "/v1/agents/shared/secrets/token")).status).toBe(200);

    const admin = createManagementClient({ url: runtime.url, key: MANAGEMENT });
    const events = await allEvents(admin, ["credential.created", "credential.used", "credential.deleted"]);
    const credentialId = events[0]!.payload.credentialId;
    expect(credentialId).toEqual(expect.any(String));
    const used = events.filter((event) => event.type === "credential.used");
    expect(used.length).toBeGreaterThan(0);
    expect(events.map(({ type, principal, source }) => ({ type, principal, source }))).toEqual([
      { type: "credential.created", principal: "backend:u:ann", source: "api" },
      ...used.map(() => ({ type: "credential.used", principal: "host", source: "runtime" })),
      { type: "credential.deleted", principal: "backend", source: "api" },
    ]);
    expect(used[0]!.payload).toEqual({
      vaultId: events[0]!.payload.vaultId,
      credentialId,
      sessionId: "s-1",
      target: url,
      outcome: "approved",
    });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});
