/**
 * R2 M3: HTTP tools. The Runtime makes the request itself, through the Tool Gate (in process, or
 * the gates service with `NYLORUN_TEST_MODEL_GATE=http`, `gates/tool-gate-http.test.ts`): the
 * input as JSON, the identity headers, the run-once key as `Idempotency-Key` and the vault
 * credential; the answer, a failure status, a timeout or a refused address is what the model
 * sees. Static approval (`approval: "always"`) on an HTTP tool or a remote MCP server waits for
 * the session's `approve`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, http, type AgentsClient } from "@nylorun/agents";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "http-tools-app-token-aaaaaaaaaaaa";
const TOKEN = "billing-secret-token-7f3c9a2e";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

/** The developer's service: each path answers one way, and every request is kept. */
async function service(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ method: req.method ?? "", path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const body = raw ? (JSON.parse(raw) as { orderId?: string }) : {};
    if (path === "/refunds") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return void res.end(JSON.stringify({ refundId: `r-${body.orderId}` }));
    }
    if (path === "/wrong") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ refund: 1 }));
    }
    if (path === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("refunded");
    }
    if (path === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(422, { "content-type": "text/plain" });
    res.end("amount is larger than the order");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/** A remote MCP server with one tool, `lookup`, counting its calls. */
async function mcpServer(): Promise<{ url: string; calls: () => number; server: Server }> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const mcp = new McpServer({ name: "orders", version: "0.0.0" });
    mcp.registerTool("lookup", { description: "Look up.", inputSchema: { orderId: z.string() } }, async ({ orderId }) => {
      calls += 1;
      return { content: [{ type: "text", text: `order ${orderId}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls: () => calls, server };
}

/** The model calls `next` once, then answers; it remembers the tool result it saw. */
let next: { name: string; args: Record<string, unknown> } = { name: "refund", args: {} };
let lastToolResult: { status?: string; output?: unknown } | undefined;
const model: ModelProvider = async (effect: { input: unknown }) => {
  const last = (effect.input as { prompt?: { kind?: string }[] }).prompt?.at(-1);
  if (last?.kind === "tool-result") {
    lastToolResult = last as typeof lastToolResult;
    return { output: [{ type: "text", text: "done" }] };
  }
  return { output: [{ type: "tool-call", id: "call-1", name: next.name, args: next.args }] };
};

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
const servers: Server[] = [];
let target: Awaited<ReturnType<typeof service>>;
let orders: Awaited<ReturnType<typeof mcpServer>>;
let runtime: Runtime;
let client: AgentsClient;
let sessions = 0;

beforeAll(async () => {
  target = await service();
  orders = await mcpServer();
  servers.push(target.server, orders.server);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const input = z.object({ orderId: z.string() });
  const output = z.object({ refundId: z.string() });
  const agent = Agent({ id: "orders", name: "Orders" })
    .tools(
      http({ name: "refund", input, output, url: `${target.url}/refunds`, method: "PUT" }),
      http({ name: "wrong", input, output, url: `${target.url}/wrong` }),
      http({ name: "text", input, url: `${target.url}/text` }),
      http({ name: "fail", input, url: `${target.url}/fail` }),
      http({ name: "slow", input, url: `${target.url}/slow`, timeoutMs: 200 }),
      http({ name: "billed", input, url: `${target.url}/refunds`, credential: "billing" }),
      http({ name: "approved", input, output, url: `${target.url}/refunds`, approval: "always" }),
    )
    .mcp({ shop: { type: "streamable-http", url: orders.url, approval: "always" } })
    .build();
  await register(runtime, agent.manifest);
});

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  lastToolResult = undefined;
});

async function register(on: Runtime, manifest: unknown) {
  const response = await fetch(`${on.url}/v1/agents/orders`, {
    method: "PUT",
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "put-orders", manifest, implementationVersion: "dev" }),
  });
  expect(response.ok).toBe(true);
}

type Session = ReturnType<AgentsClient["session"]>;

/** Opens a session, has the model call `name` with `args`, and waits for the turn to settle or pause. */
async function call(name: string, args: Record<string, unknown>, options: { vaultIds?: string[] } = {}, on = client) {
  next = { name, args };
  sessions += 1;
  const session = await on.createSession({
    id: `s${sessions}`,
    agentId: "orders",
    ownerUserId: "ada",
    ...(options.vaultIds ? { vaultIds: options.vaultIds } : {}),
  });
  await session.input("go", { idempotencyKey: `m${sessions}` });
  return session;
}

async function settled(session: Session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

async function pausedWait(session: Session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waits = await session.pending();
    if (Array.isArray(waits) && waits.length > 0) return waits[0] as { interaction: { id: string; prompt: string } };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the approval");
}

/** The `tool.completed` payloads of the session. */
async function completed(session: Session) {
  const history = await session.history();
  return history.items.filter((item) => item.type === "tool.completed").map((item) => item.payload as Record<string, unknown>);
}

describe("an HTTP tool call", () => {
  it("sends the input as JSON with the identity headers and the run-once key, and gives the model the answer", async () => {
    const before = target.seen.length;
    const session = await call("refund", { orderId: "A-1" });
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([
      expect.objectContaining({ toolName: "refund", output: { refundId: "r-A-1" } }),
    ]);
    const [request] = target.seen.slice(before);
    expect(target.seen.length - before).toBe(1);
    expect(request).toMatchObject({ method: "PUT", path: "/refunds", body: { orderId: "A-1" } });
    expect(request!.headers["content-type"]).toBe("application/json");
    expect(request!.headers["nylorun-session-id"]).toBe(session.id);
    expect(request!.headers["nylorun-agent-id"]).toBe("orders");
    const turnId = request!.headers["nylorun-turn-id"] as string;
    expect(turnId).toMatch(/\S/);
    expect(request!.headers["idempotency-key"]).toMatch(new RegExp(`^${turnId}:\\d+:tool:`));
    expect(request!.headers.authorization).toBeUndefined();
    // Never an Action.
    const history = await session.history();
    expect(history.items.some((item) => item.type === "action.pending")).toBe(false);
  });

  it("takes a text answer when the tool has no output schema", async () => {
    const session = await call("text", { orderId: "A-2" });
    await settled(session);
    expect(await completed(session)).toEqual([expect.objectContaining({ output: "refunded" })]);
  });

  it("turns an answer that does not match the output schema into a tool error", async () => {
    const session = await call("wrong", { orderId: "A-3" });
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "tool.invalid-output" }) }),
    ]);
  });

  it("gives the model a failure status with the start of its body", async () => {
    const session = await call("fail", { orderId: "A-4" });
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([
      expect.objectContaining({
        error: { code: "http.status", message: "The service answered HTTP 422: amount is larger than the order" },
      }),
    ]);
  });

  it("gives the model a timeout", async () => {
    const session = await call("slow", { orderId: "A-5" });
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([
      expect.objectContaining({ error: { code: "http.timeout", message: "The service did not answer within 200 ms" } }),
    ]);
  });

  it("adds the session's vault credential bound to the tool's URL", async () => {
    const vault = await (
      await fetch(`${runtime.url}/v1/tenant/vaults`, {
        method: "POST",
        headers: runtime.managementHeaders(),
        body: JSON.stringify({ requestId: "vault-ada", idempotencyKey: "vault-ada", name: "Billing", ownerUserId: "ada" }),
      })
    ).json();
    const created = await fetch(`${runtime.url}/v1/tenant/vaults/${vault.id}/credentials`, {
      method: "POST",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        requestId: "cred-billing",
        idempotencyKey: "cred-billing",
        name: "billing",
        auth: { type: "bearer", url: `${target.url}/refunds`, token: TOKEN },
      }),
    });
    expect(created.ok).toBe(true);
    const before = target.seen.length;
    const session = await call("billed", { orderId: "A-6" }, { vaultIds: [vault.id] });
    await settled(session);
    expect(await completed(session)).toEqual([expect.objectContaining({ output: { refundId: "r-A-6" } })]);
    expect(target.seen.slice(before).map((item) => item.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(JSON.stringify(await session.history())).not.toContain(TOKEN);

    // Without the vault, the call never leaves: the model hears why.
    const bare = await call("billed", { orderId: "A-7" });
    await settled(bare);
    expect(await completed(bare)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "http.credential" }) }),
    ]);
    expect(target.seen.length).toBe(before + 1);
  });
});

describe("static approval", () => {
  it("holds an HTTP tool call for approval, then makes it", async () => {
    const before = target.seen.length;
    const session = await call("approved", { orderId: "B-1" });
    const wait = await pausedWait(session);
    expect(wait.interaction).toMatchObject({ kind: "approval", prompt: "Approve approved?" });
    expect(target.seen.length).toBe(before);
    await session.approve(wait.interaction.id, true, { idempotencyKey: "approve-b1" });
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([expect.objectContaining({ output: { refundId: "r-B-1" } })]);
    expect(target.seen.length).toBe(before + 1);
  });

  it("never makes a denied HTTP tool call; the model sees the denial", async () => {
    const before = target.seen.length;
    const session = await call("approved", { orderId: "B-2" });
    const wait = await pausedWait(session);
    await session.approve(wait.interaction.id, false, { idempotencyKey: "deny-b2" });
    expect((await settled(session)).status).toBe("completed");
    expect(lastToolResult).toMatchObject({ status: "denied" });
    expect(target.seen.length).toBe(before);
  });

  it("holds every tool of an MCP server with approval always: approved runs, denied does not", async () => {
    const approved = await call("shop__lookup", { orderId: "C-1" });
    const wait = await pausedWait(approved);
    expect(orders.calls()).toBe(0);
    await approved.approve(wait.interaction.id, true, { idempotencyKey: "approve-c1" });
    expect((await settled(approved)).status).toBe("completed");
    expect(await completed(approved)).toEqual([expect.objectContaining({ output: "order C-1" })]);
    expect(orders.calls()).toBe(1);

    const denied = await call("shop__lookup", { orderId: "C-2" });
    const refused = await pausedWait(denied);
    await denied.approve(refused.interaction.id, false, { idempotencyKey: "deny-c2" });
    expect((await settled(denied)).status).toBe("completed");
    expect(lastToolResult).toMatchObject({ status: "denied" });
    expect(orders.calls()).toBe(1);
  });
});

it("refuses an address the Host's policy forbids", async () => {
  const strict = await startTestTenant({
    applicationKey: APP,
    modelProvider: model,
    delivery: { privateAddresses: "refuse" },
  });
  try {
    const agent = Agent({ id: "orders" })
      .tools(http({ name: "refund", input: z.object({ orderId: z.string() }), url: `${target.url}/refunds` }))
      .build();
    await register(strict, agent.manifest);
    const before = target.seen.length;
    const on = createClient({ url: strict.url, key: strict.applicationKey, tenant: strict.tenantId });
    const session = await call("refund", { orderId: "D-1" }, {}, on);
    expect((await settled(session)).status).toBe("completed");
    expect(await completed(session)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "http.refused" }) }),
    ]);
    expect(target.seen.length).toBe(before);
  } finally {
    await strict.close();
  }
});
