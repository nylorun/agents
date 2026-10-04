/**
 * F9 C1: installation vaults (`scope: "installation"`, any session may attach one; only
 * application keys see them) and the operator's credential resolver, end to end over the
 * Tenant API and a remote MCP server. With `NYLORUN_TEST_MODEL_GATE=http` the gateway
 * authorizes the MCP calls, as in the local stack; otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "installation-vaults-app-key-aaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");
const SHARED_TOKEN = "installation-shared-token-1f2e3d4c";
const RESOLVER_TOKEN = "resolver-bearer-0a1b2c3d";

const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const actingFor = (subject: string) => ({
  ...server,
  "nylorun-subject": subject,
  "nylorun-scopes": "vaults:own sessions:own",
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
    headers: options.headers ?? server,
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

/** The operator's resolver: a token per owner, or `status` for everyone. */
async function resolverServer(answer: { status?: number } = {}) {
  const asked: { authorization?: string; body: any }[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    asked.push({ ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body });
    const status = answer.status ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        status === 200 ? { headers: { authorization: `Bearer person-${body.owner}` } } : { status: "not_connected" },
      ),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return {
    config: { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/resolve`, token: RESOLVER_TOKEN },
    asked,
  };
}

/** Calls `remote__echo` once, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
  const names = (input.tools ?? []).map((tool) => tool.name);
  if (!names.includes("remote__echo") || input.prompt?.at(-1)?.kind === "tool-result")
    return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "remote__echo", args: { value: 7 } }] };
};

async function boot(options: { resolver?: { url: string; token: string }; mcpUrl?: string } = {}) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
  open.push(() => runtime.close());
  const agent = (
    options.mcpUrl
      ? Agent({ id: "bot", name: "Bot" }).mcp({ remote: { type: "streamable-http", url: options.mcpUrl } })
      : Agent({ id: "bot", name: "Bot" })
  ).build();
  const saved = await call(runtime, "PUT", "/v1/agents/bot", {
    body: { requestId: "put-bot", manifest: agent.manifest, implementationVersion: "dev" },
  });
  expect(saved.status).toBe(200);
  return runtime;
}

async function installationVault(runtime: Started, name = "Shared", key = name) {
  const created = await call(runtime, "POST", "/v1/vaults", {
    body: { requestId: `vault-${key}`, idempotencyKey: `vault-${key}`, name, scope: "installation" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string; ownerUserId: string; name: string };
}

async function bearer(runtime: Started, vaultId: string, url: string, token: string) {
  const created = await call(runtime, "POST", `/v1/vaults/${vaultId}/credentials`, {
    body: { requestId: `cred-${token}`, idempotencyKey: `cred-${token}`, name: "Shared token", auth: { type: "bearer", url, token } },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string };
}

async function runTurn(runtime: Started, sessionId: string, owner: string, body: Record<string, unknown> = {}) {
  const opened = await call(runtime, "PUT", `/v1/sessions/${sessionId}`, {
    body: { requestId: `open-${sessionId}`, agentId: "bot", ownerUserId: owner, ...body },
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

describe("installation vaults over the Tenant API", () => {
  it("lets an application key create, list, read and change them", async () => {
    const runtime = await boot();
    const vault = await installationVault(runtime);
    expect(vault).toMatchObject({ name: "Shared", ownerUserId: "installation" });
    const personal = await call(runtime, "POST", "/v1/vaults", {
      body: { requestId: "ada", idempotencyKey: "ada", name: "Ada's", ownerUserId: "ada" },
    });
    expect(personal.status).toBe(200);

    // A person's vaults, then the installation's; without an owner, only the installation's.
    const listed = await call(runtime, "GET", "/v1/vaults?ownerUserId=ada");
    expect(listed.body.vaults.map((item: { id: string }) => item.id)).toEqual([personal.body.id, vault.id]);
    const shared = await call(runtime, "GET", "/v1/vaults");
    expect(shared.body.vaults.map((item: { id: string }) => item.id)).toEqual([vault.id]);

    expect((await call(runtime, "GET", `/v1/vaults/${vault.id}`)).body).toMatchObject({ id: vault.id });
    const credential = await bearer(runtime, vault.id, "https://mcp.example.com/a", SHARED_TOKEN);
    const credentials = await call(runtime, "GET", `/v1/vaults/${vault.id}/credentials`);
    expect(credentials.body.credentials.map((item: { id: string }) => item.id)).toEqual([credential.id]);
    expect(JSON.stringify(credentials.body)).not.toContain(SHARED_TOKEN);
    const rotated = await call(runtime, "POST", `/v1/vaults/${vault.id}/credentials/${credential.id}`, {
      body: { requestId: "rot", idempotencyKey: "rot", auth: { type: "bearer", token: `${SHARED_TOKEN}-2` } },
    });
    expect(rotated.status).toBe(200);
    expect((await call(runtime, "DELETE", `/v1/vaults/${vault.id}/credentials/${credential.id}`)).status).toBe(200);
    expect((await call(runtime, "DELETE", `/v1/vaults/${vault.id}`)).status).toBe(200);
    expect((await call(runtime, "GET", `/v1/vaults/${vault.id}`)).status).toBe(404);

    // A user vault still needs its owner, which may not be the reserved `installation`.
    for (const body of [{ name: "x" }, { name: "x", ownerUserId: "installation" }])
      expect(
        (await call(runtime, "POST", "/v1/vaults", { body: { requestId: "bad", idempotencyKey: "bad", ...body } })).status,
      ).toBe(400);
  });

  it("never shows one to a request acting for a subject, nor lets it create one", async () => {
    const runtime = await boot();
    const vault = await installationVault(runtime);
    const credential = await bearer(runtime, vault.id, "https://mcp.example.com/a", SHARED_TOKEN);
    const bao = actingFor("bao");

    const created = await call(runtime, "POST", "/v1/vaults", {
      headers: bao,
      body: { requestId: "x", idempotencyKey: "x", name: "Mine", scope: "installation" },
    });
    expect(created.status).toBe(403);
    expect((await call(runtime, "GET", "/v1/vaults", { headers: bao })).body).toEqual({ vaults: [] });
    for (const [method, path] of [
      ["GET", `/v1/vaults/${vault.id}`],
      ["DELETE", `/v1/vaults/${vault.id}`],
      ["GET", `/v1/vaults/${vault.id}/credentials`],
      ["GET", `/v1/vaults/${vault.id}/credentials/${credential.id}`],
      ["DELETE", `/v1/vaults/${vault.id}/credentials/${credential.id}`],
    ] as const)
      expect((await call(runtime, method, path, { headers: bao })).status, `${method} ${path}`).toBe(404);
    expect(
      (
        await call(runtime, "POST", `/v1/vaults/${vault.id}/credentials`, {
          headers: bao,
          body: { requestId: "c", idempotencyKey: "c", name: "c", auth: { type: "bearer", url: "https://x.test/", token: "t" } },
        })
      ).status,
    ).toBe(404);
    // The subject may still not act as `installation`.
    expect((await call(runtime, "GET", "/v1/vaults", { headers: actingFor("installation") })).status).toBe(400);
    expect((await call(runtime, "GET", `/v1/vaults/${vault.id}`)).status).toBe(200);
  });

  it("never shows one to a subject token, nor lets it create one", async () => {
    const runtime = await boot();
    const vault = await installationVault(runtime);
    const policy = await call(runtime, "PUT", "/v1/access/policy", {
      body: {
        requestId: "policy",
        policy: {
          version: 1,
          roles: { user: { scopes: ["sessions:own", "vaults:own", "agents:read"], agents: "*" } },
          anon: { scopes: [], agents: [] },
          tokens: { maxTtlSeconds: 600 },
        },
      },
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const minted = await call(runtime, "POST", "/v1/tokens", {
      body: { requestId: "mint", subject: "cleo", role: "user" },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const token = { authorization: `Bearer ${minted.body.token}`, "content-type": "application/json" };

    expect(
      (
        await call(runtime, "POST", "/v1/vaults", {
          headers: token,
          body: { requestId: "x", idempotencyKey: "x", name: "Mine", scope: "installation" },
        })
      ).status,
    ).toBe(403);
    expect((await call(runtime, "GET", "/v1/vaults", { headers: token })).body).toEqual({ vaults: [] });
    expect((await call(runtime, "GET", `/v1/vaults/${vault.id}`, { headers: token })).status).toBe(404);
    expect((await call(runtime, "GET", `/v1/vaults/${vault.id}/credentials`, { headers: token })).status).toBe(404);
    // Its own user vault still works as before.
    const own = await call(runtime, "POST", "/v1/vaults", {
      headers: token,
      body: { requestId: "own", idempotencyKey: "own", name: "Mine", ownerUserId: "cleo" },
    });
    expect(own.status).toBe(200);
    expect((await call(runtime, "GET", "/v1/vaults", { headers: token })).body.vaults).toHaveLength(1);
  });

  it("keeps the host model vault hidden and unattachable", async () => {
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
    await installationVault(runtime);
    const listed = await call(runtime, "GET", "/v1/vaults?ownerUserId=host");
    expect(listed.body.vaults.map((item: { ownerUserId: string }) => item.ownerUserId)).toEqual(["installation"]);
    expect((await call(runtime, "GET", "/v1/vaults/host")).status).toBe(404);
    expect((await call(runtime, "GET", "/v1/vaults/host/credentials")).status).toBe(404);
    const attached = await call(runtime, "PUT", "/v1/sessions/s-host", {
      body: { requestId: "s-host", agentId: "bot", ownerUserId: "ada", vaultIds: ["host"] },
    });
    expect(attached.status).toBe(400);
  });
});

describe("installation vaults and the credential resolver, through MCP", () => {
  it("lets sessions of two owners use one installation vault, and select its credential", async () => {
    const remote = await remoteServer();
    const runtime = await boot({ mcpUrl: remote.url });
    const vault = await installationVault(runtime);
    const credential = await bearer(runtime, vault.id, remote.url, SHARED_TOKEN);

    const a = await runTurn(runtime, "s-a", "u:a", { vaultIds: [vault.id] });
    const b = await runTurn(runtime, "s-b", "u:b", {
      vaultIds: [vault.id],
      credentialSelections: [{ serverName: "remote", credentialId: credential.id }],
    });
    for (const session of [a, b]) {
      expect(session.status).toBe("completed");
      expect(JSON.stringify(session)).not.toContain(SHARED_TOKEN);
    }
    const calls = remote.requests.filter((item) => item.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(remote.requests.every((item) => item.authorization === `Bearer ${SHARED_TOKEN}`)).toBe(true);
  });

  it("asks the resolver once per person for many MCP requests, and never gives u:a u:b's answer", async () => {
    const remote = await remoteServer();
    const resolver = await resolverServer();
    const runtime = await boot({ mcpUrl: remote.url, resolver: resolver.config });

    expect((await runTurn(runtime, "s-a", "u:a")).status).toBe("completed");
    const forA = remote.requests.length;
    expect(forA).toBeGreaterThan(2); // initialize, tools/list, tools/call, …
    expect((await runTurn(runtime, "s-a2", "u:a")).status).toBe("completed");
    const forA2 = remote.requests.length;
    expect((await runTurn(runtime, "s-b", "u:b")).status).toBe("completed");

    expect(remote.requests.slice(0, forA2).every((item) => item.authorization === "Bearer person-u:a")).toBe(true);
    expect(remote.requests.slice(forA2).every((item) => item.authorization === "Bearer person-u:b")).toBe(true);
    expect(resolver.asked.map((item) => [item.authorization, item.body.owner, item.body.session])).toEqual([
      [`Bearer ${RESOLVER_TOKEN}`, "u:a", "s-a"],
      [`Bearer ${RESOLVER_TOKEN}`, "u:b", "s-b"],
    ]);
    expect(resolver.asked[0]!.body).toMatchObject({
      turn: expect.any(String),
      target: { kind: "mcp", server: "remote", url: remote.url },
    });
  });

  it("prefers the session's vault credential to the resolver", async () => {
    const remote = await remoteServer();
    const resolver = await resolverServer();
    const runtime = await boot({ mcpUrl: remote.url, resolver: resolver.config });
    const vault = await installationVault(runtime);
    await bearer(runtime, vault.id, remote.url, SHARED_TOKEN);
    expect((await runTurn(runtime, "s-a", "u:a", { vaultIds: [vault.id] })).status).toBe("completed");
    expect(remote.requests.every((item) => item.authorization === `Bearer ${SHARED_TOKEN}`)).toBe(true);
    expect(resolver.asked).toEqual([]);
  });

  it("goes without a credential on a 404 and refuses the server on a resolver failure", async () => {
    const remote = await remoteServer();
    const missing = await resolverServer({ status: 404 });
    const runtime = await boot({ mcpUrl: remote.url, resolver: missing.config });
    const connected = await runTurn(runtime, "s-a", "u:a");
    expect(connected.status).toBe("completed");
    expect(remote.requests.some((item) => item.method === "tools/call")).toBe(true);
    expect(remote.requests.every((item) => item.authorization === null)).toBe(true);

    const failing = await resolverServer({ status: 500 });
    const other = await boot({ mcpUrl: remote.url, resolver: failing.config });
    const before = remote.requests.length;
    const refused = await runTurn(other, "s-b", "u:b");
    expect(refused.status).toBe("completed");
    expect(remote.requests.length).toBe(before);
    expect(refused.mcpDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverName: "remote",
          outcome: "refused",
          message: expect.stringContaining("credential_unavailable"),
        }),
      ]),
    );
  });
});
