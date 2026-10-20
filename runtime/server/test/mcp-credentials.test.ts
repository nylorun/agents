/**
 * R2b C1 and C2, end to end over the Runtime API, with the credentials in Agents' vaults: header map credentials, gateway routing (`via`),
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
import { deploy, writeSecret, type AgentSource, type DeployOptions } from "./support/agents.js";
import { setToolPolicy } from "./support/tool-policy.js";

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

/**
 * A gateway like LiteLLM in front of a server whose token the provider revoked (#495): it answers
 * HTTP 200 and reports the upstream `401` in the answer. `list: "revoked"` lists no tools, with
 * `auth_required` in `_meta`; `call` fails `tools/call` with `isError`, reporting it in `_meta` or
 * only in LiteLLM's text.
 */
async function revokedGateway(options: { list?: "revoked"; call?: "meta" | "text" }) {
  const seen: Seen[] = [];
  const outcomes = { "litellm.ai/server_outcomes": { github: { status: "auth_required", http_status: 401 } } };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    seen.push({ method: body.method, path: new URL(req.url ?? "/", "http://x").pathname, headers: req.headers });
    if (body.id === undefined) return void res.writeHead(202).end();
    const tool = { name: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } };
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: body.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "litellm", version: "1.106.0" },
          }
        : body.method === "tools/list"
          ? options.list === "revoked"
            ? { tools: [], _meta: outcomes }
            : { tools: [tool] }
          : body.method === "tools/call"
            ? {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "HTTPStatusError: Client error '401 Unauthorized' for url 'https://api.githubcopilot.com/mcp/'",
                  },
                ],
                ...(options.call === "meta" ? { _meta: outcomes } : {}),
              }
            : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await listen(server);
  return { url: `${origin(server)}/mcp/github`, seen };
}

/**
 * A gateway like LiteLLM that lists every tool of the server behind it as `x-<tool>` (#494), and
 * one it names without the prefix. It answers a call to the name it listed, keeping each name.
 */
async function prefixingGateway() {
  const called: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string; params?: { name?: string } };
    if (body.method === "tools/call" && body.params?.name) called.push(body.params.name);
    const mcp = new McpServer({ name: "litellm", version: "1.106.0" });
    for (const name of ["x-echo", "x-whoami", "plain"])
      mcp.registerTool(name, { description: name, inputSchema: { value: z.string() } }, async ({ value }) => ({
        content: [{ type: "text", text: `${name} ${value}` }],
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
  return { url: `${origin(server)}/mcp/x`, called };
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
let revokedList: Awaited<ReturnType<typeof revokedGateway>>;
let revokedCall: Awaited<ReturnType<typeof revokedGateway>>;
let revokedText: Awaited<ReturnType<typeof revokedGateway>>;
let prefixing: Awaited<ReturnType<typeof prefixingGateway>>;
/** The URL the prefixed server's manifests name; the gateway reaches it. */
const X_URL = "https://x.test/mcp";
/** Ada's own Agent, guarded for her sessions. */
const ADA = "users/ada";

/** Saves `agent` as an agent manifest and makes an Agent of it, with `options`' secrets. */
async function register(agent: AgentSource, options: DeployOptions = {}) {
  await deploy(runtime.url, runtime.headers(), agent, options);
}

let sessions = 0;
/** Opens a session on Agent `agent` for `owner`, has the model call `tool`, and waits for the turn. */
async function run(agent: string, tool: string, owner = "u:ada") {
  next = tool;
  seenByModel = undefined;
  sessions += 1;
  const session = await client.createSession({ id: `cred-${sessions}`, agent, ownerUserId: owner });
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
  [revokedList, revokedCall, revokedText] = await Promise.all([
    revokedGateway({ list: "revoked" }),
    revokedGateway({ call: "meta" }),
    revokedGateway({ call: "text" }),
  ]);
  prefixing = await prefixingGateway();
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const input = z.object({ orderId: z.string() });
  // A manifest header with a credential header's name loses to the credential (R2b C2). The
  // MCP servers name no credential: the vault's secret for their URL is theirs.
  await register(
    Agent({ id: "keyed" }).mcp({
      keyed: { type: "streamable-http", url: keyed.url, headers: { "X-API-Key": "manifest-value", "x-trace": "on" } },
    }).build(),
    { secrets: { keyed: { type: "headers", url: keyed.url, headers: { "X-API-Key": API_KEY, "X-App-Key": APP_KEY } } } },
  );
  await register(Agent({ id: "rejecting" }).mcp({ locked: { type: "streamable-http", url: rejecting.url } }).build(), {
    id: ADA,
    owner: "u:ada",
    secrets: { "locked-mcp": { type: "bearer", url: rejecting.url, value: REJECTED_TOKEN } },
  });
  await register(Agent({ id: "vendor" }).mcp({ vendor: { type: "streamable-http", url: VENDOR_URL } }).build(), {
    secrets: {
      vendor: {
        type: "headers",
        url: VENDOR_URL,
        headers: { "x-gateway-key": GATEWAY_KEY },
        via: gateway.url,
        identity: { header: "X-User-Id" },
      },
    },
  });
  // Servers behind a gateway that reports their upstream 401 with HTTP 200 (#495), and the same
  // answers from servers reached directly, which are not read so.
  for (const [id, gateway, via] of [
    ["revoked-list", revokedList, true],
    ["revoked-call", revokedCall, true],
    ["revoked-text", revokedText, true],
    ["direct-list", revokedList, false],
    ["direct-call", revokedCall, false],
  ] as const) {
    const url = via ? "https://api.githubcopilot.com/mcp/" : gateway.url;
    await register(Agent({ id }).mcp({ github: { type: "streamable-http", url } }).build(), {
      secrets: {
        github: {
          type: "headers",
          url,
          headers: { "x-gateway-key": GATEWAY_KEY },
          ...(via ? { via: gateway.url, identity: { header: "x-nylorun-identity" } } : {}),
        },
      },
    });
  }
  // Through a gateway that prefixes tool names (#494): an allowlist of the server's own names, with
  // the prefix on the Agent's secret; and a manifest slot's via, whose value write adds the prefix.
  await register(
    Agent({ id: "prefixed" }).mcp({ x: { type: "streamable-http", url: X_URL, tools: { "*": { enabled: false }, echo: { enabled: true } } } }).build(),
    {
      secrets: {
        x: { type: "headers", url: X_URL, headers: { "x-gateway-key": GATEWAY_KEY }, via: prefixing.url, toolPrefix: "x-" },
      },
    },
  );
  await register(Agent({ id: "prefixed-slot" }).mcp({ x: { type: "streamable-http", url: X_URL } }).build(), {
    runtime: { kind: "none", secrets: { x: { type: "headers", url: X_URL, via: prefixing.url } } },
    secrets: { x: { headers: { "x-gateway-key": GATEWAY_KEY }, toolPrefix: "x-" } as never },
  });
  // The HTTP tools name their credentials: slots of the manifest's runtime section, whose values
  // the Agent's vault holds (protocol 16).
  await register(
    Agent({ id: "billing" })
      .tools(
        http({ name: "refund", input, url: BILLING_URL, credential: "billing" }),
        http({ name: "locked", input, url: `${service.url}/locked`, credential: "locked" }),
      )
      .build(),
    {
      runtime: {
        kind: "none",
        secrets: {
          billing: { type: "headers", url: BILLING_URL, via: `${service.url}/refunds`, identity: { header: "x-user-id" } },
          locked: { type: "headers", url: `${service.url}/locked` },
        },
      },
      secrets: { billing: { headers: { "x-api-key": BILLING_KEY } }, locked: { headers: { "x-api-key": BILLING_KEY } } },
    },
  );
});

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("header map credentials", () => {
  it("sends both headers from the Agent's secret, over the manifest's header of the same name", async () => {
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

  it("leaves the identity header out for an installation session on the same Agent", async () => {
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
    const result = await run(ADA, "locked__echo", "u:ada");
    expect(result.status).toBe("completed");
    expect(seenByModel).toMatchObject({ status: "failed", payload: { kind: "failed", code: "credential_rejected" } });
    expect(result.completed).toEqual([
      expect.objectContaining({
        toolName: "locked__echo",
        error: expect.objectContaining({ code: "credential_rejected", server: "locked" }),
      }),
    ]);
    // Protocol 11: the error names no vault scope.
    expect(result.completed[0]!.error).not.toHaveProperty("vault");
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
        error: expect.objectContaining({ code: "credential_rejected", server: "locked" }),
      }),
    ]);
    expect(result.completed[0]!.error).not.toHaveProperty("vault");
    expect(service.seen.length - before).toBe(1);
    expect(result.history).not.toContain(BILLING_KEY);
  });
});

describe("the secret routes", () => {
  it("list a headers credential's names, via and identity header, never a value", async () => {
    const listed = await fetch(`${runtime.url}/v1/agents/vendor/secrets`, {
      headers: runtime.headers(),
    }).then((response) => response.json() as Promise<{ secrets: Record<string, unknown>[] }>);
    expect(listed.secrets).toContainEqual(
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
    const body = { type: "headers", url: "https://refused.test/mcp", headers: { "x-api-key": "k" } };
    for (const [key, change] of [
      ["query", { via: "https://gateway.test/mcp?user=1" }],
      ["userinfo", { via: "https://user:pass@gateway.test/mcp" }],
      ["http", { via: "http://gateway.test/mcp" }],
      ["reserved", { headers: { "Mcp-Session-Id": "x" } }],
      ["nylorun", { headers: { "nylorun-agent-id": "x" } }],
      ["identity", { identity: { header: "content-type" } }],
    ] as const) {
      const refused = await writeSecret(runtime.url, runtime.headers(), "vendor", key, { ...body, ...change } as never);
      expect(refused.status, key).toBe(400);
    }
    expect(
      ((await fetch(`${runtime.url}/v1/agents/vendor/secrets`, { headers: runtime.headers() }).then((response) =>
        response.json(),
      )) as { secrets: { name: string }[] }).secrets.map((item) => item.name),
    ).toEqual(["vendor"]);
  });
});

describe("a gateway's report of a 401 (#495)", () => {
  it("fails discovery when the gateway lists no tools and reports auth_required for the server", async () => {
    const result = await run("revoked-list", "github__echo");
    expect(result.discovered).toEqual({
      servers: [expect.objectContaining({ serverName: "github", outcome: "failed", message: "MCP server returned 401" })],
    });
    expect(revokedList.seen.map((item) => item.method)).toContain("tools/list");
  });

  it("gives the model credential_rejected when the gateway reports it in a tool error's _meta", async () => {
    const result = await run("revoked-call", "github__echo");
    expect(result.status).toBe("completed");
    expect(seenByModel).toMatchObject({ status: "failed", payload: { kind: "failed", code: "credential_rejected" } });
    expect(result.completed).toEqual([
      expect.objectContaining({
        toolName: "github__echo",
        error: expect.objectContaining({ code: "credential_rejected", server: "github", retryable: false }),
      }),
    ]);
    expect(result.history).not.toContain(GATEWAY_KEY);
  });

  it("gives the model credential_rejected when the gateway reports it only in LiteLLM's error text", async () => {
    const result = await run("revoked-text", "github__echo");
    expect(result.completed).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "credential_rejected", server: "github" }) }),
    ]);
  });

  it("reads a server reached without via as before: connected with no tools, and a tool error", async () => {
    const listed = await run("direct-list", "github__echo");
    expect(listed.discovered).toEqual({
      servers: [expect.objectContaining({ serverName: "github", outcome: "connected", tools: 0 })],
    });
    const called = await run("direct-call", "github__echo");
    expect(called.completed).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "mcp.tool" }) }),
    ]);
  });
});

describe("a gateway's tool prefix (#494)", () => {
  it("lists the server's own names, applies tools settings keyed by them, and calls the name the gateway listed", async () => {
    const result = await run("prefixed", "x__echo");
    expect(result.status).toBe("completed");
    expect(result.discovered).toEqual({
      servers: [
        expect.objectContaining({
          serverName: "x",
          outcome: "connected",
          tools: 1,
          disabled: 2,
          message: expect.stringContaining("1 of its tools lack the gateway's tool prefix and keep the names it listed: plain"),
        }),
      ],
    });
    expect(result.discovered!.servers[0]).not.toHaveProperty("unknownTools");
    expect(result.completed).toEqual([expect.objectContaining({ toolName: "x__echo", output: "x-echo hi" })]);
    expect(prefixing.called).toEqual(["x-echo"]);
  });

  it("keeps a tool the settings disable by its own name from the gateway", async () => {
    const result = await run("prefixed", "x__whoami");
    expect(result.status).toBe("completed");
    expect(seenByModel).toMatchObject({ status: "failed" });
    expect(prefixing.called).not.toContain("x-whoami");
  });

  it("applies a tool policy rule that names the server's own tool, with the prefix on a slot's value", async () => {
    await setToolPolicy(runtime, [{ effect: "deny", kind: "mcp", server: "x", tool: "whoami" }]);
    try {
      const denied = await run("prefixed-slot", "x__whoami");
      expect(denied.history).toContain("tool.denied");
      expect(prefixing.called).not.toContain("x-whoami");
      const allowed = await run("prefixed-slot", "x__echo");
      expect(allowed.completed).toEqual([expect.objectContaining({ toolName: "x__echo", output: "x-echo hi" })]);
    } finally {
      await setToolPolicy(runtime, []);
    }
  });

  it("shows the prefix on the secret, never on the Agent's manifest slot", async () => {
    const secrets = (agent: string) =>
      fetch(`${runtime.url}/v1/agents/${agent}/secrets`, { headers: runtime.headers() }).then(
        (response) => response.json() as Promise<{ secrets: Record<string, unknown>[] }>,
      );
    for (const agent of ["prefixed", "prefixed-slot"])
      expect((await secrets(agent)).secrets).toContainEqual(
        expect.objectContaining({ name: "x", via: prefixing.url, toolPrefix: "x-" }),
      );
    const view = await fetch(`${runtime.url}/v1/agents/prefixed-slot`, { headers: runtime.headers() }).then(
      (response) => response.json() as Promise<{ runtime: { secrets: Record<string, Record<string, unknown>> } }>,
    );
    expect(view.runtime.secrets.x).toEqual({ type: "headers", url: X_URL, via: prefixing.url });
  });

  it("refuses a prefix without via", async () => {
    const refused = await writeSecret(runtime.url, runtime.headers(), "prefixed", "nowhere", {
      type: "headers",
      url: "https://nowhere.test/mcp",
      headers: { "x-api-key": "k" },
      toolPrefix: "x-",
    } as never);
    expect(refused.status).toBe(400);
  });
});
