/**
 * The exit test of track R2b (MCP credentials without OAuth, and the rest of the MCP client): one
 * agent, run end to end over the Runtime and Management APIs, the way an operator and an app
 * would. The operator previews a server's tools, then saves the agent. The agent reaches
 *
 * - `keyed`, an MCP server taking two headers, from an installation vault (`headers`);
 * - `personal`, one taking the session owner's own token, from their user vault (`bearer`);
 * - `vendor`, named `https://vendor.test/mcp` in the manifest, which the installation's credential
 *   sends to a fake gateway (`via`) with the owner in an identity header;
 * - `locked`, which answers `401` to a call; `catalog`, whose tools are deferred; and `down`,
 *   which stops listening before it is called;
 * - two HTTP tools: `refund` through the same kind of gateway, and `void_refund`, which is `401`.
 *
 * Each case checks what the model saw, what the servers received, and that no credential value
 * reached the session's record. With `NYLORUN_TEST_MODEL_GATE=http` the gates service makes every
 * call; otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, http, type AgentsClient } from "@nylorun/agents";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ModelCall, PromptContentPart } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "r2b-exit-app-key-aaaaaaaaaaaaaaaa";
const API_KEY = "exit-api-key-plaintext-1a2b3c4d";
const APP_KEY = "exit-app-key-plaintext-5e6f7a8b";
const ADA_TOKEN = "exit-ada-token-plaintext-9c0d1e2f";
const GATEWAY_KEY = "exit-gateway-key-plaintext-3a4b5c";
const LOCKED_TOKEN = "exit-locked-token-plaintext-6d7e8f";
const BILLING_KEY = "exit-billing-key-plaintext-0a1b2c";
const SECRETS = [API_KEY, APP_KEY, ADA_TOKEN, GATEWAY_KEY, LOCKED_TOKEN, BILLING_KEY];
/** The URLs the manifest names for the gateway's server and HTTP tool; nothing listens there. */
const VENDOR_URL = "https://vendor.test/mcp";
const BILLING_URL = "https://billing.test/refunds";
const KiB = 1024;

/** About 200 KiB of text. */
const BIG = Array.from({ length: 3_100 }, (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(56)}\n`).join("");
/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface Request {
  readonly method?: string;
  readonly tool?: string;
  readonly headers: IncomingMessage["headers"];
}
type Tools = (mcp: McpServer, request: IncomingMessage) => void;

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/**
 * A remote MCP server keeping every request. `require` names headers it needs on every request
 * (`401` without them); `reject` answers `401` to every `tools/call`.
 */
async function mcpServer(name: string, tools: Tools, options: { require?: Record<string, string>; reject?: boolean } = {}) {
  const seen: Request[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string; params?: { name?: string } };
    const tool = body.method === "tools/call" ? body.params?.name : undefined;
    seen.push({ method: body.method, ...(tool ? { tool } : {}), headers: req.headers });
    const missing = Object.entries(options.require ?? {}).some(([header, value]) => req.headers[header] !== value);
    if (missing || (options.reject && tool))
      return void res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end("bad credential");
    const mcp = new McpServer({ name, version: "0.0.0" });
    tools(mcp, req);
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
    seen,
    called: (tool: string) => seen.filter((item) => item.tool === tool).length,
    /** Stops listening and drops open connections: the next call finds no one there. */
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** One tool answering `text`. */
const echo: Tools = (mcp) =>
  mcp.registerTool("echo", { description: "Echoes.", inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: "text", text: `echo ${value}` }],
  }));

/** The HTTP tools' service: `/refunds` answers; `/void` answers `401`. */
async function billingService() {
  const seen: { path: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) void _;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path, headers: req.headers });
    if (path === "/void") return void res.writeHead(401, { "content-type": "text/plain" }).end("no");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refundId: "r-1" }));
  });
  await listen(server);
  return { url: origin(server), seen };
}

/** A tool result the model saw: its status, its JSON and the files beside it. */
interface Seen {
  readonly status: string;
  readonly payload: any;
  readonly media: Extract<PromptContentPart, { type: "media" }>[];
}
interface Step {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Runs before the model names the call. */
  readonly before?: () => Promise<void>;
}

let steps: Step[] = [];
let seen: Seen[] = [];
/** The tool names of every model call of the current session. */
let offered: string[][] = [];
let calls = 0;
const seenOf = (item: Extract<ModelCall["prompt"][number], { kind: "tool-result" }>): Seen => ({
  status: item.status,
  payload: JSON.parse((item.content.find((part) => part.type === "text") as { text: string }).text),
  media: item.content.filter((part) => part.type === "media") as Seen["media"],
});
/** The model makes the current script's calls in turn, keeping each result it sees, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as ModelCall;
  offered.push(input.tools.map((tool) => tool.name));
  const last = input.prompt.at(-1);
  if (last?.kind === "tool-result") seen.push(seenOf(last));
  const step = steps.shift();
  if (!step) return { output: [{ type: "text", text: "done" }] };
  await step.before?.();
  calls += 1;
  return { output: [{ type: "tool-call", id: `call-${calls}`, name: step.name, args: step.args }] };
};

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let client: AgentsClient;
let keyed: Awaited<ReturnType<typeof mcpServer>>;
let personal: Awaited<ReturnType<typeof mcpServer>>;
let gateway: Awaited<ReturnType<typeof mcpServer>>;
let locked: Awaited<ReturnType<typeof mcpServer>>;
let catalog: Awaited<ReturnType<typeof mcpServer>>;
let down: Awaited<ReturnType<typeof mcpServer>>;
let billing: Awaited<ReturnType<typeof billingService>>;
let shared: string;
let ada: string;
const sessionIds: string[] = [];

async function management(path: string, body: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: runtime.managementHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
}

async function credential(vaultId: string, name: string, auth: Record<string, unknown>) {
  const created = await management(`/v1/tenant/vaults/${vaultId}/credentials`, {
    requestId: name,
    idempotencyKey: name,
    name,
    auth,
  });
  expect(created.status, created.text).toBe(200);
}

/** Every event of a session's record, the internal ones included, as JSON. */
const recordOf = (id: string) =>
  withTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId }, async (store) =>
    (await store.record().readRange(runtime.tenantId, id, 0, Number.MAX_SAFE_INTEGER)).map(
      (record) => record.body as LiveEvent,
    ),
  );

/**
 * Opens a session of the agent for `owner`, has the model make `script`'s calls, and waits for
 * the turn. Ada's sessions attach her vault beside the installation's.
 */
async function run(owner: "u:ada" | "installation", ...script: Step[]) {
  steps = [...script];
  seen = [];
  offered = [];
  const id = `exit-${sessionIds.length + 1}`;
  sessionIds.push(id);
  const session = await client.createSession({
    id,
    agentId: "exit",
    ownerUserId: owner,
    vaultIds: owner === "installation" ? [shared] : [shared, ada],
  });
  await session.input("go", { idempotencyKey: `m-${id}` });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) {
      const history = await session.history();
      const items = history.items as { type: string; payload: Record<string, any> }[];
      return {
        status: view.status,
        completed: items.filter((item) => item.type === "tool.completed").map((item) => item.payload),
        created: items.filter((item) => item.type === "artifact.created").map((item) => item.payload),
        discovered: items.find((item) => item.type === "mcp.discovered")?.payload as { servers: Record<string, any>[] },
        recorded: await recordOf(id),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

const serverOf = (discovered: { servers: Record<string, any>[] }, name: string) =>
  discovered.servers.find((server) => server.serverName === name)!;

beforeAll(async () => {
  [keyed, personal, gateway, locked, catalog, down, billing] = await Promise.all([
    mcpServer(
      "keyed",
      (mcp) => {
        echo(mcp);
        mcp.registerTool("issues.create", { description: "Opens an issue.", inputSchema: { title: z.string() } }, async ({ title }) => ({
          content: [{ type: "text", text: `opened ${title}` }],
        }));
        mcp.registerTool("delete_repo", { description: "Deletes a repository.", inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "deleted" }],
        }));
        mcp.registerTool("screenshot", { description: "A screenshot.", inputSchema: {} }, async () => ({
          content: [
            { type: "text", text: "the page" },
            { type: "image", data: PNG, mimeType: "image/png" },
          ],
        }));
        mcp.registerTool("big_text", { description: "A long text.", inputSchema: {} }, async () => ({
          content: [{ type: "text", text: BIG }],
        }));
      },
      { require: { "x-api-key": API_KEY, "x-app-key": APP_KEY } },
    ),
    // Echoes the token it was sent: the Runtime must scrub it before the model or the record sees it.
    mcpServer(
      "personal",
      (mcp, req) =>
        mcp.registerTool("whoami", { description: "Who the token acts as.", inputSchema: {} }, async () => ({
          content: [{ type: "text", text: `ada, from ${String(req.headers.authorization)}` }],
        })),
      { require: { authorization: `Bearer ${ADA_TOKEN}` } },
    ),
    mcpServer("gateway", echo, { require: { "x-gateway-key": GATEWAY_KEY } }),
    mcpServer("locked", echo, { reject: true }),
    mcpServer("catalog", (mcp) => {
      mcp.registerTool("reconcile", { description: "Runs the month's reconciliation of two ledgers.", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "reconciled" }],
      }));
      mcp.registerTool("post", { description: "Posts an entry.", inputSchema: { amount: z.number() } }, async () => ({
        content: [{ type: "text", text: "posted" }],
      }));
    }),
    mcpServer("down", (mcp) =>
      mcp.registerTool("ping", { description: "Pings.", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "pong" }],
      })),
    ),
    billingService(),
  ]);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });

  // The operator's part: an installation vault, Ada's vault, and a credential per server URL.
  shared = (await management("/v1/tenant/vaults", { requestId: "v", idempotencyKey: "v", name: "Shared", scope: "installation" })).body.id;
  ada = (await management("/v1/tenant/vaults", { requestId: "a", idempotencyKey: "a", name: "Ada", ownerUserId: "u:ada" })).body.id;
  await credential(shared, "keyed", { type: "headers", url: keyed.url, headers: { "X-API-Key": API_KEY, "X-App-Key": APP_KEY } });
  await credential(ada, "personal", { type: "bearer", url: personal.url, token: ADA_TOKEN });
  await credential(shared, "vendor", {
    type: "headers",
    url: VENDOR_URL,
    headers: { "x-gateway-key": GATEWAY_KEY },
    via: gateway.url,
    identity: { header: "X-User-Id" },
  });
  await credential(shared, "locked", { type: "bearer", url: locked.url, token: LOCKED_TOKEN });
  await credential(shared, "billing", {
    type: "headers",
    url: BILLING_URL,
    headers: { "x-api-key": BILLING_KEY },
    via: `${billing.url}/refunds`,
    identity: { header: "X-User-Id" },
  });
  await credential(shared, "void", { type: "headers", url: `${billing.url}/void`, headers: { "x-api-key": BILLING_KEY } });
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
});

describe("the R2b exit", () => {
  it("the operator previews a server's tools, then saves the agent", async () => {
    const preview = await management("/v1/tenant/mcp/preview", { url: keyed.url, name: "keyed" });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body).toMatchObject({ credentialSent: true, serverInfo: { name: "keyed" } });
    expect(preview.body.tools.map((tool: { serverToolName: string }) => tool.serverToolName)).toEqual(
      expect.arrayContaining(["echo", "issues.create", "delete_repo", "screenshot", "big_text"]),
    );
    expect(preview.body.renamed).toEqual([{ serverToolName: "issues.create", name: "keyed__issues_create" }]);
    expect(keyed.seen.map((request) => request.method)).not.toContain("tools/call");
    // The gateway's server previews through its via, with no identity: no person asked.
    const vendor = await management("/v1/tenant/mcp/preview", { url: VENDOR_URL, name: "vendor" });
    expect(vendor.status, vendor.text).toBe(200);
    expect(vendor.body.tools).toEqual([expect.objectContaining({ modelName: "vendor__echo" })]);
    expect(gateway.seen.at(-1)!.headers["x-user-id"]).toBeUndefined();
    for (const secret of SECRETS) expect(preview.text + vendor.text).not.toContain(secret);

    const input = z.object({ orderId: z.string() });
    const agent = Agent({ id: "exit" })
      .mcp({
        keyed: { type: "streamable-http", url: keyed.url, tools: { delete_repo: { enabled: false } } },
        personal: { type: "streamable-http", url: personal.url },
        vendor: { type: "streamable-http", url: VENDOR_URL },
        locked: { type: "streamable-http", url: locked.url },
        catalog: { type: "streamable-http", url: catalog.url, deferred: true },
        down: { type: "streamable-http", url: down.url },
      })
      .tools(
        http({ name: "refund", input, url: BILLING_URL, credential: "billing" }),
        http({ name: "void_refund", input, url: `${billing.url}/void`, credential: "void" }),
      )
      .build();
    const saved = await fetch(`${runtime.url}/v1/agents/exit`, {
      method: "PUT",
      headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "put-exit", manifest: agent.manifest, implementationVersion: "dev" }),
    });
    expect(saved.status, await saved.text()).toBeLessThan(300);
  });

  it("a person's session: two headers from the installation vault, a bearer from their vault, and a gateway with their identity", async () => {
    const gatewayBefore = gateway.seen.length;
    const billingBefore = billing.seen.length;
    const result = await run(
      "u:ada",
      { name: "keyed__echo", args: { value: "hi" } },
      { name: "personal__whoami", args: {} },
      { name: "vendor__echo", args: { value: "via" } },
      { name: "refund", args: { orderId: "A-1" } },
    );
    expect(result.status).toBe("completed");
    expect(seen.map((item) => item.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(seen[0]!.payload).toBe("echo hi");
    // The server echoed the token; the model sees it scrubbed.
    expect(seen[1]!.payload).toBe("ada, from [redacted]");
    expect(seen[2]!.payload).toBe("echo via");
    expect(seen[3]!.payload).toEqual({ refundId: "r-1" });

    for (const request of keyed.seen) {
      expect(request.headers["x-api-key"]).toBe(API_KEY);
      expect(request.headers["x-app-key"]).toBe(APP_KEY);
    }
    expect(personal.called("whoami")).toBe(1);

    // The manifest names vendor.test; the gateway got every request, with Ada as the identity.
    const viaGateway = gateway.seen.slice(gatewayBefore);
    expect(viaGateway.map((request) => request.tool)).toContain("echo");
    for (const request of viaGateway) {
      expect(request.headers["x-gateway-key"]).toBe(GATEWAY_KEY);
      expect(request.headers["x-user-id"]).toBe("u:ada");
    }
    expect(serverOf(result.discovered, "vendor")).toMatchObject({ outcome: "connected", tools: 1 });
    expect(result.completed.map((item) => item.toolName)).toEqual(["keyed__echo", "personal__whoami", "vendor__echo", "refund"]);

    // The HTTP tool went through its own gateway, with the same identity.
    const [refund] = billing.seen.slice(billingBefore);
    expect(refund).toMatchObject({ path: "/refunds" });
    expect(refund!.headers["x-api-key"]).toBe(BILLING_KEY);
    expect(refund!.headers["x-user-id"]).toBe("u:ada");
  });

  it("an installation session: the gateway gets no identity header", async () => {
    const gatewayBefore = gateway.seen.length;
    const billingBefore = billing.seen.length;
    const result = await run(
      "installation",
      { name: "vendor__echo", args: { value: "app" } },
      { name: "refund", args: { orderId: "A-2" } },
    );
    expect(result.status).toBe("completed");
    expect(seen.map((item) => item.payload)).toEqual(["echo app", { refundId: "r-1" }]);
    const requests = [...gateway.seen.slice(gatewayBefore), ...billing.seen.slice(billingBefore)];
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) expect(request.headers["x-user-id"]).toBeUndefined();
    // Ada's vault is not attached, so her server has no credential here.
    expect(serverOf(result.discovered, "personal").outcome).not.toBe("connected");
  });

  it("a 401 is credential_rejected to the model, from an MCP server and from an HTTP tool, and is not retried", async () => {
    const voidBefore = billing.seen.filter((request) => request.path === "/void").length;
    const result = await run("u:ada", { name: "locked__echo", args: { value: "x" } }, { name: "void_refund", args: { orderId: "A-3" } });
    expect(result.status).toBe("completed");
    for (const item of seen) expect(item).toMatchObject({ status: "failed", payload: { kind: "failed", code: "credential_rejected" } });
    expect(result.completed).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "credential_rejected", server: "locked", vault: "installation" }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: "credential_rejected", server: "void", vault: "installation" }) }),
    ]);
    expect(locked.called("echo")).toBe(1);
    expect(locked.seen.find((request) => request.tool)!.headers.authorization).toBe(`Bearer ${LOCKED_TOKEN}`);
    expect(billing.seen.filter((request) => request.path === "/void").length - voidBefore).toBe(1);
  });

  it("an image and a 200 KiB result become artifacts, and the model gets previews", async () => {
    const result = await run("u:ada", { name: "keyed__screenshot", args: {} }, { name: "keyed__big_text", args: {} });
    expect(result.status).toBe("completed");
    const [image, text] = result.created;
    expect(image).toMatchObject({ contentType: "image/png", source: "engine" });
    expect(seen[0]!.payload).toEqual([
      { type: "text", text: "the page" },
      { type: "image", artifactId: image!.artifactId, version: 1, contentType: "image/png", size: 70 },
    ]);
    expect(seen[0]!.media).toEqual([
      expect.objectContaining({ type: "media", mediaType: "image/png", reference: expect.objectContaining({ artifactId: image!.artifactId }) }),
    ]);
    expect(seen[1]!.payload).toEqual({
      truncated: true,
      artifactId: text!.artifactId,
      version: 1,
      contentType: "text/plain; charset=utf-8",
      size: Buffer.byteLength(BIG),
      preview: expect.any(String),
    });
    expect(Buffer.byteLength(BIG)).toBeGreaterThan(200 * KiB);
    expect(seen[1]!.payload.preview.startsWith(BIG.slice(0, 3_000))).toBe(true);
    const content = await fetch(`${runtime.url}/v1/artifacts/${text!.artifactId}/versions/latest/content`, {
      headers: { authorization: `Bearer ${APP}` },
    });
    expect(await content.text()).toBe(BIG);
    const largest = Math.max(...result.recorded.map((event) => Buffer.byteLength(JSON.stringify(event))));
    expect(largest).toBeLessThan(64 * KiB);
  });

  it("finds a deferred tool with tool_search and runs it with tool_call; a disabled tool never appears; a dotted name is renamed and callable", async () => {
    const result = await run(
      "u:ada",
      { name: "tool_search", args: { query: "reconciliation" } },
      { name: "tool_call", args: { name: "catalog__reconcile", arguments: {} } },
      { name: "keyed__issues_create", args: { title: "flaky" } },
      { name: "keyed__delete_repo", args: {} },
    );
    expect(result.status).toBe("completed");
    // Deferred: the catalog's tools leave the list for tool_search and tool_call, the same at every step.
    for (const names of offered) {
      expect(names).toEqual(offered[0]);
      expect(names).toEqual(expect.arrayContaining(["tool_search", "tool_call", "keyed__issues_create", "keyed__echo"]));
      expect(names.filter((name) => name.startsWith("catalog__"))).toEqual([]);
      expect(names).not.toContain("keyed__delete_repo");
    }
    expect(seen[0]!.payload.tools[0]).toMatchObject({ name: "catalog__reconcile", description: expect.stringContaining("reconciliation") });
    expect(seen[1]).toMatchObject({ status: "completed", payload: "reconciled" });
    expect(catalog.called("reconcile")).toBe(1);
    // The dotted name: the model calls keyed__issues_create, the server gets issues.create.
    expect(seen[2]).toMatchObject({ status: "completed", payload: "opened flaky" });
    expect(keyed.called("issues.create")).toBe(1);
    // The disabled tool: never offered, never sent.
    expect(seen[3]!.status).toBe("failed");
    expect(keyed.called("delete_repo")).toBe(0);
    expect(result.completed.map((item) => item.toolName)).toEqual(
      expect.arrayContaining(["tool_search", "catalog__reconcile", "keyed__issues_create"]),
    );
    expect(serverOf(result.discovered, "keyed")).toMatchObject({
      disabled: 1,
      renamed: [{ serverToolName: "issues.create", name: "keyed__issues_create" }],
    });
    expect(serverOf(result.discovered, "catalog")).toMatchObject({ deferred: 2 });
  });

  it("a server that is down is a retryable mcp.unreachable", async () => {
    const result = await run("u:ada", { name: "down__ping", args: {}, before: () => down.stop() });
    expect(result.status).toBe("completed");
    expect(seen[0]).toMatchObject({ status: "failed", payload: { kind: "failed", code: "mcp.unreachable", retryable: true } });
    expect(result.completed).toEqual([
      expect.objectContaining({ toolName: "down__ping", error: expect.objectContaining({ code: "mcp.unreachable", retryable: true }) }),
    ]);
    expect(down.called("ping")).toBe(0);
  });

  it("no credential value is anywhere in a session's record", async () => {
    expect(sessionIds.length).toBeGreaterThanOrEqual(6);
    for (const id of sessionIds) {
      const recorded = JSON.stringify(await recordOf(id));
      expect(recorded).toContain("tool.completed");
      for (const secret of SECRETS) expect(recorded, `${secret} in ${id}`).not.toContain(secret);
    }
  });
});
