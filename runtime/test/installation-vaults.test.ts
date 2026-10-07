/**
 * F9 C1: installation vaults (`scope: "installation"`, any session may attach one; only
 * management keys see them, protocol 8) and a person's own user vault, end to end over the
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
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { testIssuer } from "./support/issuer.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "installation-vaults-app-key-aaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");
const SHARED_TOKEN = "installation-shared-token-1f2e3d4c";
const PERSONAL_TOKEN = "personal-token-0a1b2c3d";

const MANAGEMENT = "installation-vaults-management-key-aa";

const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
/** The Management API's key (protocol 8): the vault routes take it alone. */
const management = { authorization: `Bearer ${MANAGEMENT}`, "content-type": "application/json" };
const actingFor = (subject: string) => ({
  ...server,
  "nylorun-subject": subject,
  "nylorun-scopes": "sessions:own",
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

/** Every vault route, for a vault and credential that exist. */
function vaultRoutes(vaultId: string, credentialId: string): [string, string, unknown?][] {
  const write = { requestId: "x", idempotencyKey: "x" };
  return [
    ["POST", "/v1/tenant/vaults", { ...write, name: "Mine", scope: "installation" }],
    ["POST", "/v1/tenant/vaults", { ...write, name: "Mine", ownerUserId: "cleo" }],
    ["GET", "/v1/tenant/vaults"],
    ["GET", `/v1/tenant/vaults/${vaultId}`],
    ["DELETE", `/v1/tenant/vaults/${vaultId}`],
    ["POST", `/v1/tenant/vaults/${vaultId}/credentials`, { ...write, name: "c", auth: { type: "bearer", url: "https://x.test/", token: "t" } }],
    ["GET", `/v1/tenant/vaults/${vaultId}/credentials`],
    ["GET", `/v1/tenant/vaults/${vaultId}/credentials/${credentialId}`],
    ["POST", `/v1/tenant/vaults/${vaultId}/credentials/${credentialId}`, { ...write, auth: { type: "bearer", token: "t2" } }],
    ["DELETE", `/v1/tenant/vaults/${vaultId}/credentials/${credentialId}`],
  ];
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
  const saved = await call(runtime, "PUT", "/v1/agents/bot", {
    body: { requestId: "put-bot", manifest: agent.manifest, implementationVersion: "dev" },
  });
  expect(saved.status).toBe(200);
  return runtime;
}

async function installationVault(runtime: Started, name = "Shared", key = name) {
  const created = await call(runtime, "POST", "/v1/tenant/vaults", {
    body: { requestId: `vault-${key}`, idempotencyKey: `vault-${key}`, name, scope: "installation" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string; ownerUserId: string; name: string };
}

async function bearer(runtime: Started, vaultId: string, url: string, token: string) {
  const created = await call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/credentials`, {
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
  it("lets a management key create, list, read and change them", async () => {
    const runtime = await boot();
    const vault = await installationVault(runtime);
    expect(vault).toMatchObject({ name: "Shared", ownerUserId: "installation" });
    const personal = await call(runtime, "POST", "/v1/tenant/vaults", {
      body: { requestId: "ada", idempotencyKey: "ada", name: "Ada's", ownerUserId: "ada" },
    });
    expect(personal.status).toBe(200);

    // A person's vaults, then the installation's; without an owner, only the installation's.
    const listed = await call(runtime, "GET", "/v1/tenant/vaults?ownerUserId=ada");
    expect(listed.body.vaults.map((item: { id: string }) => item.id)).toEqual([personal.body.id, vault.id]);
    const shared = await call(runtime, "GET", "/v1/tenant/vaults");
    expect(shared.body.vaults.map((item: { id: string }) => item.id)).toEqual([vault.id]);

    expect((await call(runtime, "GET", `/v1/tenant/vaults/${vault.id}`)).body).toMatchObject({ id: vault.id });
    const credential = await bearer(runtime, vault.id, "https://mcp.example.com/a", SHARED_TOKEN);
    const credentials = await call(runtime, "GET", `/v1/tenant/vaults/${vault.id}/credentials`);
    expect(credentials.body.credentials.map((item: { id: string }) => item.id)).toEqual([credential.id]);
    expect(JSON.stringify(credentials.body)).not.toContain(SHARED_TOKEN);
    const rotated = await call(runtime, "POST", `/v1/tenant/vaults/${vault.id}/credentials/${credential.id}`, {
      body: { requestId: "rot", idempotencyKey: "rot", auth: { type: "bearer", token: `${SHARED_TOKEN}-2` } },
    });
    expect(rotated.status).toBe(200);
    expect((await call(runtime, "DELETE", `/v1/tenant/vaults/${vault.id}/credentials/${credential.id}`)).status).toBe(200);
    expect((await call(runtime, "DELETE", `/v1/tenant/vaults/${vault.id}`)).status).toBe(200);
    expect((await call(runtime, "GET", `/v1/tenant/vaults/${vault.id}`)).status).toBe(404);

    // A user vault still needs its owner, which may not be the reserved `installation`.
    for (const body of [{ name: "x" }, { name: "x", ownerUserId: "installation" }])
      expect(
        (await call(runtime, "POST", "/v1/tenant/vaults", { body: { requestId: "bad", idempotencyKey: "bad", ...body } })).status,
      ).toBe(400);
  });

  it("refuses every vault route to an application key and to a request acting for a subject (protocol 8)", async () => {
    const runtime = await boot();
    const vault = await installationVault(runtime);
    const credential = await bearer(runtime, vault.id, "https://mcp.example.com/a", SHARED_TOKEN);
    const managementActing = {
      ...management,
      "nylorun-subject": "bao",
      "nylorun-scopes": "sessions:own",
    };
    for (const [headers, code] of [
      [server, "key_role_mismatch"],
      [actingFor("bao"), "key_role_mismatch"],
      [{ ...actingFor("bao"), "nylorun-scopes": "vaults:own" }, "key_role_mismatch"],
      [managementActing, "subject_invalid"],
    ] as const)
      for (const [method, path, body] of vaultRoutes(vault.id, credential.id)) {
        const reply = await call(runtime, method, path, { headers, ...(body ? { body } : {}) });
        expect(reply.status, `${method} ${path}`).toBe(403);
        expect(reply.body.code).toBe(code);
      }
    expect((await call(runtime, "GET", `/v1/tenant/vaults/${vault.id}`)).status).toBe(200);
  });

  it("refuses every vault route to a trusted issuer's token (protocol 8)", async () => {
    const issuer = await testIssuer();
    const runtime = await boot({ issuers: createTrustedIssuers(issuer.configs) });
    const vault = await installationVault(runtime);
    const credential = await bearer(runtime, vault.id, "https://mcp.example.com/a", SHARED_TOKEN);
    const token = {
      authorization: `Bearer ${await issuer.sign("cleo", "sessions:own agents:read")}`,
      "content-type": "application/json",
    };
    for (const [method, path, body] of vaultRoutes(vault.id, credential.id)) {
      const reply = await call(runtime, method, path, { headers: token, ...(body ? { body } : {}) });
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body.code).toBe("scope_required");
    }
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
    const listed = await call(runtime, "GET", "/v1/tenant/vaults?ownerUserId=host");
    expect(listed.body.vaults.map((item: { ownerUserId: string }) => item.ownerUserId)).toEqual(["installation"]);
    expect((await call(runtime, "GET", "/v1/tenant/vaults/host")).status).toBe(404);
    expect((await call(runtime, "GET", "/v1/tenant/vaults/host/credentials")).status).toBe(404);
    const attached = await call(runtime, "PUT", "/v1/sessions/s-host", {
      body: { requestId: "s-host", agentId: "bot", ownerUserId: "ada", vaultIds: ["host"] },
    });
    expect(attached.status).toBe(400);
  });
});

describe("installation and user vaults, through MCP", () => {
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

  it("uses a person's own user vault for their sessions, and sends nothing when no attached vault holds one", async () => {
    const remote = await remoteServer();
    const runtime = await boot({ mcpUrl: remote.url });
    const personal = await call(runtime, "POST", "/v1/tenant/vaults", {
      body: { requestId: "vault-a", idempotencyKey: "vault-a", name: "A's", ownerUserId: "u:a" },
    });
    expect(personal.status).toBe(200);
    await bearer(runtime, personal.body.id, remote.url, PERSONAL_TOKEN);

    expect((await runTurn(runtime, "s-a", "u:a", { vaultIds: [personal.body.id] })).status).toBe("completed");
    const forA = remote.requests.length;
    expect(forA).toBeGreaterThan(2); // initialize, tools/list, tools/call, …
    expect((await runTurn(runtime, "s-b", "u:b")).status).toBe("completed");

    expect(remote.requests.slice(0, forA).every((item) => item.authorization === `Bearer ${PERSONAL_TOKEN}`)).toBe(true);
    expect(remote.requests.slice(forA).every((item) => item.authorization === null)).toBe(true);
    // Another person's vault does not attach to u:b's session.
    const attached = await call(runtime, "PUT", "/v1/sessions/s-b2", {
      body: { requestId: "s-b2", agentId: "bot", ownerUserId: "u:b", vaultIds: [personal.body.id] },
    });
    expect(attached.status).toBe(403);
  });
});
