/**
 * R2b C1 and C2, end to end over the Tenant API: header map credentials, gateway routing (`via`),
 * the identity header, and a `401` the model sees as `credential_rejected`, for remote MCP servers
 * and HTTP tools alike. With `NYLORUN_TEST_MODEL_GATE=http` the gates service makes every call
 * (`gates/tool-gate-credentials.test.ts`); otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, http, type AgentsClient } from "@nylorun/agents";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "mcp-credentials-app-key-aaaaaaaaaa";
const API_KEY = "vendor-api-key-plaintext-1a2b3c4d";
const APP_KEY = "vendor-app-key-plaintext-5e6f7a8b";
const GATEWAY_KEY = "gateway-key-plaintext-9c0d1e2f";
const REJECTED_TOKEN = "rejected-token-plaintext-3a4b5c6d";
const BILLING_KEY = "billing-key-plaintext-7e8f9a0b";
/** The URL the gateway manifest names; nothing listens there. */
const VENDOR_URL = "https://vendor.test/mcp";
const BILLING_URL = "https://billing.test/refunds";

interface Seen {
  readonly method?: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
}

/**
 * A remote MCP server with one `echo` tool, keeping each request. `reject` answers `401` to
 * `tools/call` only, after an `initialize` and `tools/list` that work.
 */
async function mcpServer(options: { reject?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string };
    seen.push({ method: body.method, path: new URL(req.url ?? "/", "http://x").pathname, headers: req.headers });
    if (options.reject && body.method === "tools/call")
      return void res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end(`bad key ${req.headers.authorization}`);
    const mcp = new McpServer({ name: "remote", version: "0.0.0" });
    mcp.registerTool("echo", { description: "Echoes.", inputSchema: { value: z.string() } }, async ({ value }) => ({
      content: [{ type: "text", text: `echo ${value}` }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await listen(server);
  return { url: `${origin(server)}/mcp`, seen, calls: () => seen.filter((item) => item.method === "tools/call") };
}

/** An HTTP tool's service: `/refunds` answers, `/locked` answers `401`. */
async function httpService() {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) void _;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path, headers: req.headers });
    if (path === "/locked") return void res.writeHead(401, { "content-type": "text/plain" }).end(`no ${req.headers["x-api-key"]}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refundId: "r-1" }));
  });
  await listen(server);
  return { url: origin(server), seen };
}

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** The model calls `next` once, then answers; it keeps the tool result it saw. */
let next = "keyed__echo";
let seenByModel: { status?: string; payload?: Record<string, unknown> } | undefined;
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as {
    prompt?: { kind?: string; status?: string; content?: { text?: string }[] }[];
  };
  const last = input.prompt?.at(-1);
  if (last?.kind === "tool-result") {
    seenByModel = { status: last.status, payload: JSON.parse(last.content?.[0]?.text ?? "null") };
    return { output: [{ type: "text", text: "done" }] };
  }
  const args = next.includes("__") ? { value: "hi" } : { orderId: "A-1" };
  return { output: [{ type: "tool-call", id: "call-1", name: next, args }] };
};

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let client: AgentsClient;
let keyed: Awaited<ReturnType<typeof mcpServer>>;
let rejecting: Awaited<ReturnType<typeof mcpServer>>;
let gateway: Awaited<ReturnType<typeof mcpServer>>;
let service: Awaited<ReturnType<typeof httpService>>;
let shared: string;
let ada: string;

async function management(path: string, body: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function credential(vaultId: string, key: string, auth: Record<string, unknown>) {
  const created = await management(`/v1/tenant/vaults/${vaultId}/credentials`, {
    requestId: key,
    idempotencyKey: key,
    name: key,
    auth,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

async function register(id: string, agent: { manifest: unknown }) {
  const response = await fetch(`${runtime.url}/v1/agents/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: `put-${id}`, manifest: agent.manifest, implementationVersion: "dev" }),
  });
  expect(response.ok).toBe(true);
}

let sessions = 0;
/** Opens a session of `agentId` for `owner`, has the model call `tool`, and waits for the turn. */
async function run(agentId: string, tool: string, owner = "u:ada", vaultIds = [shared]) {
  next = tool;
  seenByModel = undefined;
  sessions += 1;
  const session = await client.createSession({ id: `cred-${sessions}`, agentId, ownerUserId: owner, vaultIds });
  await session.input("go", { idempotencyKey: `m${sessions}` });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) {
      const history = await session.history();
      const items = history.items as { type: string; payload: Record<string, any> }[];
      return {
        status: view.status,
        completed: items.filter((item) => item.type === "tool.completed").map((item) => item.payload),
        discovered: items.find((item) => item.type === "mcp.discovered")?.payload,
        history: JSON.stringify(history),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

beforeAll(async () => {
  [keyed, rejecting, gateway, service] = await Promise.all([
    mcpServer(),
    mcpServer({ reject: true }),
    mcpServer(),
    httpService(),
  ]);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const input = z.object({ orderId: z.string() });
  // A manifest header with a credential header's name loses to the credential (R2b C2).
  await register("keyed", Agent({ id: "keyed" }).mcp({
    keyed: { type: "streamable-http", url: keyed.url, headers: { "X-API-Key": "manifest-value", "x-trace": "on" } },
  }).build());
  await register("rejecting", Agent({ id: "rejecting" }).mcp({ locked: { type: "streamable-http", url: rejecting.url } }).build());
  await register("vendor", Agent({ id: "vendor" }).mcp({ vendor: { type: "streamable-http", url: VENDOR_URL } }).build());
  await register(
    "billing",
    Agent({ id: "billing" })
      .tools(
        http({ name: "refund", input, url: BILLING_URL, credential: "billing" }),
        http({ name: "locked", input, url: `${service.url}/locked`, credential: "locked" }),
      )
      .build(),
  );
  shared = (await management("/v1/tenant/vaults", { requestId: "v", idempotencyKey: "v", name: "Shared", scope: "installation" })).body.id;
  ada = (await management("/v1/tenant/vaults", { requestId: "a", idempotencyKey: "a", name: "Ada", ownerUserId: "u:ada" })).body.id;
  await credential(shared, "keyed", { type: "headers", url: keyed.url, headers: { "X-API-Key": API_KEY, "X-App-Key": APP_KEY } });
  await credential(ada, "locked-mcp", { type: "bearer", url: rejecting.url, token: REJECTED_TOKEN });
  await credential(shared, "vendor", {
    type: "headers",
    url: VENDOR_URL,
    headers: { "x-gateway-key": GATEWAY_KEY },
    via: gateway.url,
    identity: { header: "X-User-Id" },
  });
  await credential(shared, "billing", {
    type: "headers",
    url: BILLING_URL,
    headers: { "x-api-key": BILLING_KEY },
    via: `${service.url}/refunds`,
    identity: { header: "x-user-id" },
  });
  await credential(shared, "locked", { type: "headers", url: `${service.url}/locked`, headers: { "x-api-key": BILLING_KEY } });
});

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("header map credentials", () => {
  it("sends both headers from the installation vault, over the manifest's header of the same name", async () => {
    const result = await run("keyed", "keyed__echo");
    expect(result.status).toBe("completed");
    expect(result.completed).toEqual([expect.objectContaining({ output: "echo hi" })]);
    expect(keyed.seen.length).toBeGreaterThan(2);
    for (const request of keyed.seen) {
      expect(request.headers["x-api-key"]).toBe(API_KEY);
      expect(request.headers["x-app-key"]).toBe(APP_KEY);
      expect(request.headers["x-trace"]).toBe("on");
    }
    for (const secret of [API_KEY, APP_KEY]) expect(result.history).not.toContain(secret);
  });
});

describe("a credential with via (a gateway)", () => {
  it("sends the server's requests to the gateway with the owner's identity, and keeps the manifest's tool names", async () => {
    const before = gateway.seen.length;
    const result = await run("vendor", "vendor__echo");
    expect(result.status).toBe("completed");
    expect(result.discovered).toEqual({
      servers: [expect.objectContaining({ serverName: "vendor", outcome: "connected", tools: 1 })],
    });
    expect(result.completed).toEqual([expect.objectContaining({ toolName: "vendor__echo", output: "echo hi" })]);
    const requests = gateway.seen.slice(before);
    expect(requests.map((item) => item.method)).toContain("tools/call");
    for (const request of requests) {
      expect(request.path).toBe("/mcp");
      expect(request.headers["x-gateway-key"]).toBe(GATEWAY_KEY);
      expect(request.headers["x-user-id"]).toBe("u:ada");
    }
    expect(result.history).not.toContain(GATEWAY_KEY);
  });

  it("leaves the identity header out for an installation session", async () => {
    const before = gateway.seen.length;
    const result = await run("vendor", "vendor__echo", "installation");
    expect(result.status).toBe("completed");
    const requests = gateway.seen.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers["x-gateway-key"]).toBe(GATEWAY_KEY);
      expect(request.headers["x-user-id"]).toBeUndefined();
    }
  });

  it("sends an HTTP tool's call to its via, with the identity header", async () => {
    const before = service.seen.length;
    const result = await run("billing", "refund");
    expect(result.completed).toEqual([expect.objectContaining({ output: { refundId: "r-1" } })]);
    const [request] = service.seen.slice(before);
    expect(service.seen.length - before).toBe(1);
    expect(request).toMatchObject({ path: "/refunds" });
    expect(request!.headers["x-api-key"]).toBe(BILLING_KEY);
    expect(request!.headers["x-user-id"]).toBe("u:ada");
    expect(request!.headers["nylorun-session-id"]).toBeDefined();
    expect(result.history).not.toContain(BILLING_KEY);
  });
});

describe("a 401 (R2b C1)", () => {
  it("gives the model credential_rejected for an MCP tool call, once, with a diagnostic", async () => {
    const result = await run("rejecting", "locked__echo", "u:ada", [ada]);
    expect(result.status).toBe("completed");
    expect(seenByModel).toMatchObject({ status: "failed", payload: { kind: "failed", code: "credential_rejected" } });
    expect(result.completed).toEqual([
      expect.objectContaining({
        toolName: "locked__echo",
        error: expect.objectContaining({ code: "credential_rejected", server: "locked", vault: "user" }),
      }),
    ]);
    expect(rejecting.calls()).toHaveLength(1);
    expect(rejecting.calls()[0]!.headers.authorization).toBe(`Bearer ${REJECTED_TOKEN}`);
    expect(result.history).not.toContain(REJECTED_TOKEN);
  });

  it("gives the model credential_rejected for an HTTP tool, once, without the answer's body", async () => {
    const before = service.seen.length;
    const result = await run("billing", "locked");
    expect(result.status).toBe("completed");
    expect(seenByModel).toMatchObject({ status: "failed", payload: { kind: "failed", code: "credential_rejected" } });
    expect(result.completed).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "credential_rejected", server: "locked", vault: "installation" }),
      }),
    ]);
    expect(service.seen.length - before).toBe(1);
    expect(result.history).not.toContain(BILLING_KEY);
  });
});

describe("the vault routes", () => {
  it("list a headers credential's names, via and identity header, never a value", async () => {
    const listed = await fetch(`${runtime.url}/v1/tenant/vaults/${shared}/credentials`, {
      headers: runtime.managementHeaders(),
    }).then((response) => response.json() as Promise<{ credentials: Record<string, unknown>[] }>);
    expect(listed.credentials).toContainEqual(
      expect.objectContaining({
        name: "vendor",
        type: "headers",
        binding: { url: VENDOR_URL },
        headerNames: ["x-gateway-key"],
        via: gateway.url,
        identity: { header: "x-user-id" },
      }),
    );
    for (const secret of [API_KEY, APP_KEY, GATEWAY_KEY, BILLING_KEY])
      expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("refuse a via with a query string, userinfo or plain http, and a reserved header name", async () => {
    const auth = { type: "headers", url: "https://refused.test/mcp", headers: { "x-api-key": "k" } };
    for (const [key, change] of [
      ["query", { via: "https://gateway.test/mcp?user=1" }],
      ["userinfo", { via: "https://user:pass@gateway.test/mcp" }],
      ["http", { via: "http://gateway.test/mcp" }],
      ["reserved", { headers: { "Mcp-Session-Id": "x" } }],
      ["nylorun", { headers: { "nylorun-agent-id": "x" } }],
      ["identity", { identity: { header: "content-type" } }],
    ] as const) {
      const refused = await management(`/v1/tenant/vaults/${shared}/credentials`, {
        requestId: `bad-${key}`,
        idempotencyKey: `bad-${key}`,
        name: key,
        auth: { ...auth, ...change },
      });
      expect(refused.status, key).toBe(400);
    }
  });
});
