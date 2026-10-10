/**
 * R2b C6, C7 and C8 end to end over the Tenant API: a renamed MCP tool the model can call, MCP
 * failures the model sees with a code, a lost answer the model sees only for a read-only tool,
 * and no credential value in a tool's result, error or event. With `NYLORUN_TEST_MODEL_GATE=http`
 * the gates service makes every call (`gates/tool-gate-errors.test.ts`); otherwise the Tenant
 * does, in process.
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

const APP = "mcp-errors-app-key-aaaaaaaaaaaaaa";
const TOKEN = "mcp-bearer-plaintext-0a1b2c3d4e5f";
const HTTP_KEY = "http-tool-key-plaintext-6a7b8c9d";
/** Not a credential: it survives, though its key looks secret (Q16). */
const NEXT_TOKEN = "cursor-page-2-abcdefghijkl";

interface Seen {
  readonly method?: string;
  readonly tool?: string;
}

/**
 * A remote MCP server whose tools fail as their names say. `files.read` and `echo` answer;
 * `forbidden` answers 403, `rpc_error` a JSON-RPC error, `boom` a 500 that echoes the
 * Authorization header, and `lookup` (read-only) and `charge` drop the connection after the
 * call arrived.
 */
async function faultyServer() {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    const tool = body.method === "tools/call" ? body.params?.name : undefined;
    seen.push({ method: body.method, ...(tool ? { tool } : {}) });
    const authorization = req.headers.authorization ?? "";
    if (tool === "forbidden") return void res.writeHead(403, { "content-type": "text/plain" }).end("not yours");
    if (tool === "boom")
      return void res.writeHead(500, { "content-type": "text/plain" }).end(`upstream failed for ${authorization}`);
    if (tool === "rpc_error")
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "No issue -1" } }));
    if (tool === "lookup" || tool === "charge") return void req.socket.destroy();
    const mcp = new McpServer({ name: "faulty", version: "0.0.0" });
    const input = { value: z.string() };
    mcp.registerTool("files.read", { description: "Reads.", inputSchema: input }, async ({ value }) => ({
      content: [{ type: "text", text: `read ${value}` }],
    }));
    mcp.registerTool("echo", { description: "Echoes the request.", inputSchema: input }, async () => ({
      content: [{ type: "text", text: `You sent ${authorization}` }],
      structuredContent: { authorization, nextToken: NEXT_TOKEN },
    }));
    for (const name of ["forbidden", "rpc_error", "boom", "charge"])
      mcp.registerTool(name, { description: name, inputSchema: input }, async () => ({ content: [] }));
    mcp.registerTool(
      "lookup",
      { description: "Looks up.", inputSchema: input, annotations: { readOnlyHint: true } },
      async () => ({ content: [] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await listen(server);
  return {
    url: `${origin(server)}/mcp`,
    calls: (name: string) => seen.filter((item) => item.tool === name).length,
  };
}

/**
 * An MCP server that stops listening once it has listed its tools: the call that follows
 * finds no one there.
 */
async function vanishingServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string };
    const mcp = new McpServer({ name: "vanishing", version: "0.0.0" });
    mcp.registerTool("ping", { description: "Pings.", inputSchema: { value: z.string() } }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
      if (body.method === "tools/list") {
        server.close();
        server.closeAllConnections();
      }
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `${origin(server)}/mcp` };
}

/** An HTTP tool's service that echoes its key into its answer, and into an error body. */
async function echoService() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) void _;
    const key = String(req.headers["x-api-key"] ?? "");
    if (req.url === "/fail") return void res.writeHead(502, { "content-type": "text/plain" }).end(`bad gateway for ${key}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ key, nextToken: NEXT_TOKEN }));
  });
  await listen(server);
  return { url: origin(server) };
}

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** The model calls `next` once, then answers; it keeps the tool result it saw. */
let next = "faulty__echo";
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
let faulty: Awaited<ReturnType<typeof faultyServer>>;
let vanishing: Awaited<ReturnType<typeof vanishingServer>>;
let service: Awaited<ReturnType<typeof echoService>>;
let shared: string;

async function management(path: string, body: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function register(id: string, manifest: unknown) {
  return fetch(`${runtime.url}/v1/agents/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: `put-${id}`, manifest, implementationVersion: "dev" }),
  });
}

let sessions = 0;
/** Opens a session of `agentId`, has the model call `tool`, and waits for the turn. */
async function run(agentId: string, tool: string) {
  next = tool;
  seenByModel = undefined;
  sessions += 1;
  const session = await client.createSession({ id: `err-${sessions}`, agentId, ownerUserId: "u:ada", vaultIds: [shared] });
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
  [faulty, vanishing, service] = await Promise.all([faultyServer(), vanishingServer(), echoService()]);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const input = z.object({ orderId: z.string() });
  const put = async (agent: { manifest: unknown }) => {
    const response = await register((agent.manifest as { id: string }).id, agent.manifest);
    expect(response.ok).toBe(true);
  };
  await put(Agent({ id: "faulty" }).mcp({ faulty: { type: "streamable-http", url: faulty.url } }).build());
  await put(Agent({ id: "vanishing" }).mcp({ vanishing: { type: "streamable-http", url: vanishing.url } }).build());
  await put(
    Agent({ id: "echoing" })
      .tools(
        http({ name: "lookup", input, url: `${service.url}/ok`, credential: "echo" }),
        http({ name: "failing", input, url: `${service.url}/fail`, credential: "echo-fail" }),
      )
      .build(),
  );
  shared = (await management("/v1/tenant/vaults", { requestId: "v", idempotencyKey: "v", name: "Shared", scope: "installation" })).body.id;
  for (const [name, auth] of [
    ["faulty", { type: "bearer", url: faulty.url, token: TOKEN }],
    ["echo", { type: "headers", url: `${service.url}/ok`, headers: { "x-api-key": HTTP_KEY } }],
    ["echo-fail", { type: "headers", url: `${service.url}/fail`, headers: { "x-api-key": HTTP_KEY } }],
  ] as const) {
    const created = await management(`/v1/tenant/vaults/${shared}/credentials`, {
      requestId: name,
      idempotencyKey: name,
      name,
      auth,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  }
});

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("tool names every model accepts (R2b C6)", () => {
  it("lists a dotted tool under a name the model can call, and calls the server by its own", async () => {
    const result = await run("faulty", "faulty__files_read");
    expect(result.discovered).toEqual({
      servers: [
        expect.objectContaining({
          serverName: "faulty",
          outcome: "connected",
          renamed: [{ serverToolName: "files.read", name: "faulty__files_read" }],
        }),
      ],
    });
    expect(result.completed).toEqual([expect.objectContaining({ toolName: "faulty__files_read", output: "read hi" })]);
  });

  it("refuses to save a tool or an MCP server whose name a model would refuse", async () => {
    const dotted = Agent({ id: "dotted" }).mcp({ "files.v2": { type: "streamable-http", url: faulty.url } }).build();
    const refused = await register("dotted", dotted.manifest);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("MCP server name 'files.v2'");
    const tool = Agent({ id: "dotted-tool" })
      .tools(http({ name: "refunds.create", input: z.object({ id: z.string() }), url: `${service.url}/ok` }))
      .build();
    const toolRefused = await register("dotted-tool", tool.manifest);
    expect(toolRefused.status).toBe(400);
    expect(JSON.stringify(await toolRefused.json())).toContain("Tool name 'refunds.create'");
  });
});

describe("errors the model can act on (R2b C7)", () => {
  /** The failure the model saw, and the `tool.completed` error it was recorded as. */
  async function failed(tool: string) {
    const result = await run("faulty", tool);
    expect(result.status).toBe("completed");
    expect(seenByModel?.status).toBe("failed");
    expect(result.completed).toHaveLength(1);
    return { model: seenByModel!.payload!, event: result.completed[0]!.error as Record<string, unknown>, result };
  }

  it("a 403 is mcp.forbidden", async () => {
    const { model, event } = await failed("faulty__forbidden");
    expect(model).toMatchObject({ kind: "failed", code: "mcp.forbidden", retryable: false });
    expect(model.message).toContain("HTTP 403: not yours");
    expect(event).toMatchObject({ code: "mcp.forbidden", retryable: false });
    expect(faulty.calls("forbidden")).toBe(1);
  });

  it("a JSON-RPC error is mcp.error, with its code", async () => {
    const { model, event } = await failed("faulty__rpc_error");
    expect(model).toMatchObject({ kind: "failed", code: "mcp.error", retryable: false });
    expect(model.message).toContain("-32602");
    expect(model.message).toContain("No issue -1");
    expect(event).toMatchObject({ code: "mcp.error" });
  });

  it("a 500 is mcp.status", async () => {
    const { model, event } = await failed("faulty__boom");
    expect(model).toMatchObject({ kind: "failed", code: "mcp.status", retryable: false });
    expect(model.message).toContain("HTTP 500: upstream failed for");
    expect(event).toMatchObject({ code: "mcp.status" });
  });

  it("a read-only tool's lost answer is mcp.lost to the model", async () => {
    const { model, event } = await failed("faulty__lookup");
    expect(model).toMatchObject({ kind: "failed", code: "mcp.lost", retryable: true });
    expect(event).toMatchObject({ code: "mcp.lost" });
    expect(faulty.calls("lookup")).toBe(1);
  });

  it("another tool's lost answer leaves the call uncertain, for an operator", async () => {
    const result = await run("faulty", "faulty__charge");
    expect(result.status).toBe("uncertain");
    expect(seenByModel).toBeUndefined();
    expect(result.completed).toEqual([]);
    expect(result.history).toContain("effect.uncertain");
    expect(faulty.calls("charge")).toBe(1);
  });

  it("a refused connection is mcp.unreachable, and may be tried again", async () => {
    const result = await run("vanishing", "vanishing__ping");
    expect(result.status).toBe("completed");
    expect(seenByModel?.payload).toMatchObject({ kind: "failed", code: "mcp.unreachable", retryable: true });
    expect(result.completed).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "mcp.unreachable", retryable: true }) }),
    ]);
  });
});

describe("no secret in a result (R2b C8)", () => {
  it("replaces the bearer a server echoes in its result, and keeps nextToken", async () => {
    const result = await run("faulty", "faulty__echo");
    expect(result.status).toBe("completed");
    const [completed] = result.completed;
    expect(completed).toMatchObject({
      output: { authorization: "[redacted]", nextToken: NEXT_TOKEN },
      redacted: 2,
    });
    expect(seenByModel?.payload).toEqual({ authorization: "[redacted]", nextToken: NEXT_TOKEN });
    expect(result.history).not.toContain(TOKEN);
  });

  it("replaces the bearer a server echoes in an error", async () => {
    const result = await run("faulty", "faulty__boom");
    expect(result.completed[0]).toMatchObject({
      error: { code: "mcp.status", message: expect.stringContaining("upstream failed for [redacted]") },
      redacted: 1,
    });
    expect(JSON.stringify(seenByModel)).not.toContain(TOKEN);
    expect(result.history).not.toContain(TOKEN);
  });

  it("replaces an HTTP tool's key in its answer and in its error body", async () => {
    const ok = await run("echoing", "lookup");
    expect(ok.completed[0]).toMatchObject({ output: { key: "[redacted]", nextToken: NEXT_TOKEN }, redacted: 1 });
    expect(ok.history).not.toContain(HTTP_KEY);
    const failing = await run("echoing", "failing");
    expect(failing.completed[0]).toMatchObject({
      error: { code: "http.status", message: "The service answered HTTP 502: bad gateway for [redacted]" },
      redacted: 1,
    });
    expect(failing.history).not.toContain(HTTP_KEY);
    expect(JSON.stringify(seenByModel)).not.toContain(HTTP_KEY);
  });
});
