/**
 * An Agent's secrets (protocol 16; an Environment's from protocol 11, D56):
 * `PUT|GET|DELETE /v1/agents/{id}/secrets/{name}` and the list, end to end over the Runtime API
 * and a remote MCP server. A write replaces by name, values are write-only, a second credential
 * for a host or a URL is refused at write (`409 credential_conflict`), a token caller reaches
 * only the Agents its grants match, every change has an audit row, and deleting the Agent
 * deletes its vault. With
 * `NYLORUN_TEST_MODEL_GATE=http` the gateway authorizes the MCP calls, as in the local stack;
 * otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { manifestOf, saveManifest } from "./support/agents.js";
import { testIssuer } from "./support/issuer.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";
import type { VaultAuditRow } from "../src/store/types.js";

const APP = "environment-secrets-app-key-aaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");
const SHARED_TOKEN = "environment-shared-token-1f2e3d4c";
const PERSONAL_TOKEN = "personal-token-0a1b2c3d";
const GH_VALUE = "gh-secret-plaintext-value-5e6f7a8b";
const DD_VALUE = "datadog-plaintext-value-9c8d7e6f";

const MANAGEMENT = "environment-secrets-management-key-aa";

const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const management = { authorization: `Bearer ${MANAGEMENT}`, "content-type": "application/json" };
const actingFor = (subject: string, scopes = "sessions:own") => ({
  ...server,
  "nylorun-subject": subject,
  "nylorun-scopes": scopes,
});

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

async function call(
  runtime: Started,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: options.headers ?? (path.startsWith("/v1/tenant") ? management : server),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: response.status, body };
}

const secretPath = (agentId: string, name?: string) =>
  `/v1/agents/${encodeURIComponent(agentId)}/secrets${name === undefined ? "" : `/${name}`}`;

/** A remote MCP server with one `echo` tool, recording each request's Authorization. */
async function remoteServer() {
  const requests: { method?: string; authorization: string | null }[] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as { method?: string }) : undefined;
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    requests.push({ method: body?.method, authorization });
    const mcp = new McpServer({ name: "remote", version: "0.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echoes.", inputSchema: { value: z.number() } },
      async ({ value }) => ({ content: [{ type: "text", text: String(value) }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, requests };
}

/** Calls `remote__echo` once, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
  const names = (input.tools ?? []).map((tool) => tool.name);
  if (!names.includes("remote__echo") || input.prompt?.at(-1)?.kind === "tool-result")
    return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "remote__echo", args: { value: 7 } }] };
};

async function boot(
  options: {
    mcpUrl?: string;
    issuers?: ReturnType<typeof createTrustedIssuers>;
  } = {},
) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    managementKey: MANAGEMENT,
    vaultKek: KEK,
    modelProvider: model,
    ...(options.issuers ? { issuers: options.issuers } : {}),
  });
  open.push(() => runtime.close());
  const agent = (
    options.mcpUrl
      ? Agent({ id: "bot", name: "Bot" }).mcp({ remote: { type: "streamable-http", url: options.mcpUrl } })
      : Agent({ id: "bot", name: "Bot" })
  ).build();
  // Agent manifest `bot`, of kind none: every Agent here is made from it.
  await saveManifest(runtime.url, server, manifestOf(agent));
  return runtime;
}

async function makeAgent(runtime: Started, id: string, body: Record<string, unknown> = {}) {
  const created = await call(runtime, "PUT", `/v1/agents/${encodeURIComponent(id)}`, {
    body: { manifest: "bot", ...body },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

async function put(runtime: Started, agentId: string, name: string, body: unknown, headers = server) {
  return call(runtime, "PUT", secretPath(agentId, name), { headers, body });
}

async function bearer(runtime: Started, agentId: string, url: string, token: string) {
  const created = await put(runtime, agentId, "token", { type: "bearer", url, value: token });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

/** The vault id and audit rows of Agent `agentId`'s vault, read from the store. */
async function audit(runtime: Started, agentId: string, vaultId?: string) {
  return withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      const id = vaultId ?? (await t.vaultOfEnvironment(agentId))?.id;
      if (!id) throw new Error(`Agent ${agentId} has no vault`);
      return { vaultId: id, rows: await t.vaultAudit({ vaultId: id }) };
    }),
  );
}

const actions = (rows: VaultAuditRow[]) => rows.map((row) => `${row.action}:${row.outcome}:${row.actor}`);

async function runTurn(runtime: Started, sessionId: string, owner: string, agent: string) {
  const opened = await call(runtime, "PUT", `/v1/sessions/${sessionId}`, {
    body: { requestId: `open-${sessionId}`, agent, ownerUserId: owner },
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const sent = await call(runtime, "POST", `/v1/sessions/${sessionId}/commands`, {
    body: { type: "message", requestId: `m-${sessionId}`, idempotencyKey: `m-${sessionId}`, content: "go" },
  });
  expect(sent.status).toBe(200);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await call(runtime, "GET", `/v1/sessions/${sessionId}`);
    if (["completed", "failed", "uncertain"].includes(view.body.status)) return view.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} did not finish`);
}

describe("Agent secrets over the Runtime API", () => {
  it("replaces a secret by name, never answers a value, and audits each change", async () => {
    const runtime = await boot();
    await makeAgent(runtime, "team/web");
    const gh = await put(runtime, "team/web", "GH_TOKEN", {
      type: "environment_secret",
      value: GH_VALUE,
      allowedHosts: ["API.github.com"],
      inject: { header: "Authorization", format: "token {value}" },
    });
    expect(gh.status).toBe(200);
    expect(gh.body).toEqual({
      name: "GH_TOKEN",
      type: "environment_secret",
      binding: { allowedHosts: ["api.github.com"], inject: { header: "Authorization", format: "token {value}" } },
      createdAt: expect.any(String),
    });
    const region = await put(runtime, "team/web", "REGION", { type: "environment_variable", value: "eu-west-1" });
    expect(region.body).toEqual({ name: "REGION", type: "environment_variable", binding: {}, createdAt: expect.any(String) });
    const token = await bearer(runtime, "team/web", "https://mcp.example.com/a", SHARED_TOKEN);
    expect(token).toEqual({
      name: "token",
      type: "bearer",
      binding: { url: "https://mcp.example.com/a" },
      createdAt: expect.any(String),
    });
    const datadog = await put(runtime, "team/web", "datadog", {
      type: "headers",
      url: "https://mcp.example.com/datadog",
      headers: { "DD-API-KEY": DD_VALUE },
      via: "https://gateway.example.com/mcp",
      identity: { header: "X-User-Id" },
    });
    expect(datadog.body).toMatchObject({
      type: "headers",
      headerNames: ["dd-api-key"],
      via: "https://gateway.example.com/mcp",
      identity: { header: "x-user-id" },
    });

    // The same name and type re-seals: the credential keeps its id and creation time.
    const rotated = await put(runtime, "team/web", "GH_TOKEN", {
      type: "environment_secret",
      value: `${GH_VALUE}-2`,
      allowedHosts: ["api.github.com", "uploads.github.com"],
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toEqual({
      name: "GH_TOKEN",
      type: "environment_secret",
      binding: {
        allowedHosts: ["api.github.com", "uploads.github.com"],
        inject: { header: "Authorization", format: "Bearer {value}" },
      },
      createdAt: gh.body.createdAt,
      rotatedAt: expect.any(String),
    });
    // Another type under the name replaces it with a new credential.
    const replaced = await put(runtime, "team/web", "token", {
      type: "headers",
      url: "https://mcp.example.com/a",
      headers: { "x-api-key": SHARED_TOKEN },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: "token", type: "headers", headerNames: ["x-api-key"] });
    expect(replaced.body.rotatedAt).toBeUndefined();

    const listed = await call(runtime, "GET", secretPath("team/web"));
    expect(listed.status).toBe(200);
    expect(listed.body.secrets.map((item: { name: string; type: string }) => [item.name, item.type])).toEqual([
      ["datadog", "headers"],
      ["GH_TOKEN", "environment_secret"],
      ["REGION", "environment_variable"],
      ["token", "headers"],
    ]);
    const read = await call(runtime, "GET", secretPath("team/web", "GH_TOKEN"));
    expect(read.body).toEqual(rotated.body);
    for (const value of [GH_VALUE, DD_VALUE, SHARED_TOKEN, "eu-west-1"])
      for (const answer of [gh, region, token, datadog, rotated, replaced, listed, read].map((item) =>
        JSON.stringify("body" in item ? item.body : item),
      ))
        expect(answer).not.toContain(value);

    const deleted = await call(runtime, "DELETE", secretPath("team/web", "REGION"), { headers: actingFor("u:ada", "agents:write") });
    expect(deleted).toEqual({ status: 200, body: { id: "REGION" } });
    expect((await call(runtime, "GET", secretPath("team/web", "REGION"))).status).toBe(404);
    expect((await call(runtime, "DELETE", secretPath("team/web", "REGION"))).status).toBe(404);

    const { rows } = await audit(runtime, "team/web");
    expect(actions(rows)).toEqual([
      "create:created:application",
      "create:created:application",
      "create:created:application",
      "create:created:application",
      "create:created:application",
      "rotate:rotated:application",
      "delete:deleted:application",
      "create:created:application",
      "delete:deleted:u:ada",
    ]);
    expect(rows[0]).toMatchObject({ credentialId: null, target: "team/web" });
    expect(JSON.stringify(rows)).not.toContain(GH_VALUE);
  });

  it("refuses a second credential for a host or a URL (409 credential_conflict)", async () => {
    const runtime = await boot();
    await makeAgent(runtime, "team/web");
    expect(
      (await put(runtime, "team/web", "GH_TOKEN", { type: "environment_secret", value: GH_VALUE, allowedHosts: ["api.github.com", "uploads.github.com"] })).status,
    ).toBe(200);
    const host = await put(runtime, "team/web", "GITHUB_TOKEN", {
      type: "environment_secret",
      value: "another",
      allowedHosts: ["uploads.github.com"],
    });
    expect(host.status).toBe(409);
    expect(host.body).toMatchObject({
      code: "credential_conflict",
      details: { host: "uploads.github.com", existing: "GH_TOKEN" },
    });

    await bearer(runtime, "team/web", "https://mcp.example.com/a", SHARED_TOKEN);
    // The same URL once normalized: a default port is no other URL.
    for (const url of ["https://mcp.example.com/a", "https://mcp.example.com:443/a"]) {
      const same = await put(runtime, "team/web", "other", { type: "headers", url, headers: { "x-api-key": "k" } });
      expect(same.status, url).toBe(409);
      expect(same.body).toMatchObject({
        code: "credential_conflict",
        details: { url: "https://mcp.example.com/a", existing: "token" },
      });
    }
    // Another URL, another variable on other hosts, and another Agent are no conflict.
    expect((await put(runtime, "team/web", "other", { type: "bearer", url: "https://mcp.example.com/b", value: "t" })).status).toBe(200);
    expect(
      (await put(runtime, "team/web", "NPM_TOKEN", { type: "environment_secret", value: "npm", allowedHosts: ["registry.npmjs.org"] })).status,
    ).toBe(200);
    await makeAgent(runtime, "team/api");
    expect(
      (await put(runtime, "team/api", "GITHUB_TOKEN", { type: "environment_secret", value: "another", allowedHosts: ["uploads.github.com"] })).status,
    ).toBe(200);
    expect(
      (await call(runtime, "GET", secretPath("team/web"))).body.secrets.map((item: { name: string }) => item.name),
    ).toEqual(["GH_TOKEN", "NPM_TOKEN", "other", "token"]);
  });

  it("validates names and bodies", async () => {
    const runtime = await boot();
    await makeAgent(runtime, "team/web");
    for (const [name, body] of [
      ["has space", { type: "bearer", url: "https://mcp.example.com/a", value: "t" }],
      ["1BAD", { type: "environment_variable", value: "v" }],
      ["PATH", { type: "environment_variable", value: "v" }],
      ["GH_TOKEN", { type: "environment_secret", value: "v", allowedHosts: ["*.github.com"] }],
      ["GH_TOKEN", { type: "environment_secret", value: "v", allowedHosts: [] }],
      ["GH_TOKEN", { type: "environment_variable", value: "a\nb" }],
      ["token", { type: "bearer", url: "https://mcp.example.com/a", token: "old-field" }],
      ["token", { type: "oauth", url: "https://mcp.example.com/a" }],
      ["token", { type: "bearer", url: "not a url", value: "t" }],
    ] as const) {
      const refused = await put(runtime, "team/web", encodeURIComponent(name), body);
      expect(refused.status, `${name} ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await call(runtime, "GET", secretPath("team/web"))).body).toEqual({ secrets: [] });
    expect((await put(runtime, "missing", "token", { type: "bearer", url: "https://mcp.example.com/a", value: "t" })).status).toBe(404);
  });

  it("reaches only the Agents a token's grants match, and writes only with agents:write", async () => {
    const issuer = await testIssuer({ agents: ["{team}/*"] });
    const runtime = await boot({ issuers: createTrustedIssuers(issuer.configs) });
    await makeAgent(runtime, "team-a/web");
    await makeAgent(runtime, "team-b/web");
    await bearer(runtime, "team-b/web", "https://mcp.example.com/a", SHARED_TOKEN);
    const token = async (scopes: string) => ({
      authorization: `Bearer ${await issuer.sign("cleo", scopes, { claims: { team: "team-a" } })}`,
      "content-type": "application/json",
    });
    const writer = await token("sessions:own agents:write");
    const reader = await token("sessions:own");
    const body = { type: "bearer", url: "https://mcp.example.com/a", value: PERSONAL_TOKEN };

    expect((await put(runtime, "team-a/web", "token", body, writer)).status).toBe(200);
    expect((await call(runtime, "GET", secretPath("team-a/web"), { headers: reader })).body.secrets).toHaveLength(1);
    expect((await call(runtime, "GET", secretPath("team-a/web", "token"), { headers: reader })).status).toBe(200);
    // Outside the grants: the 404 of a missing one, for every secret route.
    for (const [method, path, payload] of [
      ["GET", secretPath("team-b/web")],
      ["GET", secretPath("team-b/web", "token")],
      ["PUT", secretPath("team-b/web", "token"), body],
      ["DELETE", secretPath("team-b/web", "token")],
    ] as const) {
      const reply = await call(runtime, method, path, { headers: writer, ...(payload ? { body: payload } : {}) });
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    // Without agents:write a token, or a request acting for a subject, writes nothing.
    for (const headers of [reader, actingFor("cleo")])
      for (const [method, path, payload] of [
        ["PUT", secretPath("team-a/web", "token"), body],
        ["DELETE", secretPath("team-a/web", "token")],
      ] as const) {
        const reply = await call(runtime, method, path, { headers, ...(payload ? { body: payload } : {}) });
        expect(reply.status, `${method} ${path}`).toBe(403);
        expect(reply.body.code).toBe("scope_required");
      }
    // The Management API's key is not the Runtime API's.
    const managed = await put(runtime, "team-a/web", "token", body, management);
    expect(managed.status).toBe(403);
    expect(managed.body.code).toBe("key_role_mismatch");
    // team-b's secret is untouched.
    const { rows } = await audit(runtime, "team-b/web");
    expect(actions(rows)).toEqual(["create:created:application", "create:created:application"]);
    expect(actions((await audit(runtime, "team-a/web")).rows)).toEqual([
      "create:created:application",
      "create:created:cleo",
    ]);
  });

  it("keeps another owner's sessions out by the owner guard: 403 for the application, 404 acting for a person", async () => {
    const issuer = await testIssuer({ agents: ["users/*"] });
    const runtime = await boot({ issuers: createTrustedIssuers(issuer.configs) });
    await makeAgent(runtime, "users/dana", { owner: "dana" });
    await bearer(runtime, "users/dana", "https://mcp.example.com/a", PERSONAL_TOKEN);
    const open = (sessionId: string, owner: string, headers: Record<string, string>) =>
      call(runtime, "PUT", `/v1/sessions/${sessionId}`, {
        headers,
        body: { requestId: sessionId, agent: "users/dana", ownerUserId: owner },
      });
    const application = await open("s-app", "cleo", server);
    expect(application.status).toBe(403);
    expect(application.body.code).toBe("agent_owner_mismatch");
    expect((await open("s-subject", "cleo", actingFor("cleo"))).status).toBe(404);
    const token = {
      authorization: `Bearer ${await issuer.sign("cleo", "sessions:own")}`,
      "content-type": "application/json",
    };
    expect((await open("s-token", "cleo", token)).status).toBe(404);
    const own = await open("s-dana", "dana", server);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ agentId: "users/dana", manifest: { name: "bot", version: 1 } });
  });

  it("deletes an Agent's vault, with every secret, when the Agent is deleted", async () => {
    const runtime = await boot();
    await makeAgent(runtime, "team/web");
    await bearer(runtime, "team/web", "https://mcp.example.com/a", SHARED_TOKEN);
    expect(
      (await put(runtime, "team/web", "GH_TOKEN", { type: "environment_secret", value: GH_VALUE, allowedHosts: ["api.github.com"] })).status,
    ).toBe(200);
    const before = await audit(runtime, "team/web");
    const deleted = await call(runtime, "DELETE", "/v1/agents/team%2Fweb", { headers: actingFor("u:ada", "agents:write") });
    expect(deleted.body).toEqual({ id: "team/web", deleted: true });
    expect((await call(runtime, "GET", secretPath("team/web"))).status).toBe(404);
    expect((await call(runtime, "GET", secretPath("team/web", "token"))).status).toBe(404);
    const after = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => ({
        vault: await t.getVault(before.vaultId),
        credentials: await t.credentialsForVault(before.vaultId),
        rows: await t.vaultAudit({ vaultId: before.vaultId }),
      })),
    );
    expect(after.vault).toBeUndefined();
    expect(after.credentials).toEqual([]);
    expect(actions(after.rows.slice(before.rows.length))).toEqual([
      "delete:deleted:u:ada",
      "delete:deleted:u:ada",
      "delete:deleted:u:ada",
    ]);
    expect(after.rows.at(-1)).toMatchObject({ credentialId: null, target: "team/web" });

    // An Agent made again with the id has a new, empty vault.
    await makeAgent(runtime, "team/web");
    expect((await call(runtime, "GET", secretPath("team/web"))).body).toEqual({ secrets: [] });
    expect((await audit(runtime, "team/web")).vaultId).not.toBe(before.vaultId);
  });

  it("keeps the host model vault out of reach, and has no vault Management routes", async () => {
    const runtime = await boot();
    const saved = await call(runtime, "PUT", "/v1/tenant/model", {
      body: {
        requestId: "host",
        idempotencyKey: "host",
        provider: "custom",
        model: "fixture",
        baseUrl: "https://models.example.test/v1",
        auth: { type: "api_key", key: "host-model-key-123456" },
      },
    });
    expect(saved.status).toBe(200);
    expect((await call(runtime, "GET", secretPath("host"))).status).toBe(404);
    expect((await call(runtime, "GET", secretPath("host", "custom"))).status).toBe(404);
    const attached = await call(runtime, "PUT", "/v1/sessions/s-host", {
      body: { requestId: "s-host", agent: "host", ownerUserId: "ada" },
    });
    expect(attached.status).toBe(404);
    for (const [method, path] of [
      ["GET", "/v1/tenant/vaults"],
      ["POST", "/v1/tenant/vaults"],
      ["GET", "/v1/tenant/vaults/host"],
      ["GET", "/v1/tenant/vaults/host/credentials"],
    ] as const)
      expect((await call(runtime, method, path, method === "POST" ? { body: {} } : {})).status, `${method} ${path}`).toBe(404);
  });
});

describe("Agent secrets, through MCP", () => {
  it("lets sessions of two owners use one shared Agent's credential", async () => {
    const remote = await remoteServer();
    const runtime = await boot({ mcpUrl: remote.url });
    await makeAgent(runtime, "shared");
    await bearer(runtime, "shared", remote.url, SHARED_TOKEN);

    const a = await runTurn(runtime, "s-a", "u:a", "shared");
    const b = await runTurn(runtime, "s-b", "u:b", "shared");
    for (const session of [a, b]) {
      expect(session.status).toBe("completed");
      expect(JSON.stringify(session)).not.toContain(SHARED_TOKEN);
    }
    const calls = remote.requests.filter((item) => item.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(remote.requests.every((item) => item.authorization === `Bearer ${SHARED_TOKEN}`)).toBe(true);
  });

  it("uses a person's own Agent for their sessions, and sends nothing from an Agent without one", async () => {
    const remote = await remoteServer();
    const runtime = await boot({ mcpUrl: remote.url });
    await makeAgent(runtime, "users/a", { owner: "u:a" });
    await bearer(runtime, "users/a", remote.url, PERSONAL_TOKEN);
    await makeAgent(runtime, "users/b");

    expect((await runTurn(runtime, "s-a", "u:a", "users/a")).status).toBe("completed");
    const forA = remote.requests.length;
    expect(forA).toBeGreaterThan(2); // initialize, tools/list, tools/call, …
    expect((await runTurn(runtime, "s-b", "u:b", "users/b")).status).toBe("completed");

    expect(remote.requests.slice(0, forA).every((item) => item.authorization === `Bearer ${PERSONAL_TOKEN}`)).toBe(true);
    expect(remote.requests.slice(forA).every((item) => item.authorization === null)).toBe(true);
    // Another person's Agent does not open for u:b's session.
    const attached = await call(runtime, "PUT", "/v1/sessions/s-b2", {
      body: { requestId: "s-b2", agent: "users/a", ownerUserId: "u:b" },
    });
    expect(attached.status).toBe(403);
    expect(attached.body.code).toBe("agent_owner_mismatch");
  });

  it("sends a rotated value from the next request, and nothing once the secret is deleted", async () => {
    const remote = await remoteServer();
    const runtime = await boot({ mcpUrl: remote.url });
    await makeAgent(runtime, "shared");
    await bearer(runtime, "shared", remote.url, SHARED_TOKEN);
    expect((await runTurn(runtime, "s-1", "u:a", "shared")).status).toBe("completed");
    const first = remote.requests.length;
    await bearer(runtime, "shared", remote.url, `${SHARED_TOKEN}-2`);
    expect((await runTurn(runtime, "s-2", "u:a", "shared")).status).toBe("completed");
    const second = remote.requests.length;
    expect((await call(runtime, "DELETE", secretPath("shared", "token"))).status).toBe(200);
    expect((await runTurn(runtime, "s-3", "u:a", "shared")).status).toBe("completed");
    expect(remote.requests.slice(0, first).every((item) => item.authorization === `Bearer ${SHARED_TOKEN}`)).toBe(true);
    expect(remote.requests.slice(first, second).every((item) => item.authorization === `Bearer ${SHARED_TOKEN}-2`)).toBe(true);
    expect(remote.requests.slice(second).every((item) => item.authorization === null)).toBe(true);
    expect(remote.requests.length).toBeGreaterThan(second);
  });
});
