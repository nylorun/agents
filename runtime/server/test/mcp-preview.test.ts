/**
 * R2b C12: `POST /v1/tenant/mcp/preview` lists a remote MCP server's tools with the installation
 * vault's credential for its URL, and calls none. With `NYLORUN_TEST_MODEL_GATE=http` the keys
 * service in the gates service runs it; otherwise the Tenant does, in process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpPreviewSchema } from "@nylorun/core/contracts";
import { previewMcpServer, previewServerName } from "../src/mcp/preview.js";
import { HttpError } from "../src/tenant/http.js";
import { startTestTenant } from "./support/tenant.js";

const API_KEY = "preview-api-key-plaintext-1a2b3c4d";
const APP_KEY = "preview-app-key-plaintext-5e6f7a8b";
const GATEWAY_KEY = "preview-gateway-key-plaintext-9c0d";
/** The URL the gateway credential names; nothing listens there. */
const VENDOR_URL = "https://vendor.test/mcp";

interface Seen {
  readonly method?: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
}

/**
 * A remote MCP server with a read-only `search` tool and a dotted `issues.create`. With
 * `requireKey`, a request without that `x-api-key` is `401`. It echoes the key into its
 * instructions, which the preview must not return.
 */
async function mcpServer(options: { requireKey?: string } = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string };
    seen.push({ method: body.method, path: new URL(req.url ?? "/", "http://x").pathname, headers: req.headers });
    if (options.requireKey !== undefined && req.headers["x-api-key"] !== options.requireKey)
      return void res.writeHead(401).end("no key");
    const mcp = new McpServer(
      { name: "issue-tracker", version: "1.2.3" },
      { instructions: `Search before creating. Your key is ${String(req.headers["x-api-key"])}.` },
    );
    mcp.registerTool(
      "search",
      {
        description: "Searches issues.",
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true, title: "Search issues" },
      },
      async () => ({ content: [{ type: "text", text: "nothing" }] }),
    );
    mcp.registerTool(
      "issues.create",
      { description: "Creates an issue.", inputSchema: { title: z.string(), body: z.string().optional() } },
      async () => ({ content: [{ type: "text", text: "created" }] }),
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
  return { url: `${origin(server)}/mcp`, seen };
}

/**
 * An OAuth-only server: every MCP request is `401`. With `named`, the challenge names its
 * metadata (`resource_metadata`); without it, the metadata is only at the well-known path.
 */
async function oauthServer(options: { named: boolean }) {
  const fetched: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) void _;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const self = origin(server);
    const metadataPath = options.named ? "/meta/resource.json" : "/.well-known/oauth-protected-resource/mcp";
    if (req.method === "GET" && path === metadataPath) {
      fetched.push(path);
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ resource: `${self}/mcp`, authorization_servers: ["https://auth.vendor.test"], scopes_supported: ["read"] }));
    }
    if (req.method === "GET") {
      fetched.push(path);
      return void res.writeHead(404).end();
    }
    res
      .writeHead(401, {
        "www-authenticate": options.named
          ? `Bearer realm="vendor", resource_metadata="${self}${metadataPath}"`
          : 'Bearer realm="vendor"',
      })
      .end();
  });
  await listen(server);
  return { url: `${origin(server)}/mcp`, fetched };
}

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let refusing: Runtime;
let keyed: Awaited<ReturnType<typeof mcpServer>>;
let gateway: Awaited<ReturnType<typeof mcpServer>>;
let open: Awaited<ReturnType<typeof mcpServer>>;
let shared: string;
let other: string;
let ada: string;

async function post(on: Runtime, path: string, body: unknown, headers = on.managementHeaders()) {
  const response = await fetch(`${on.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
}

const preview = (body: Record<string, unknown>, on = runtime) => post(on, "/v1/tenant/mcp/preview", body);

async function vault(name: string, scope: "installation" | "user") {
  const created = await post(runtime, "/v1/tenant/vaults", {
    requestId: name,
    idempotencyKey: name,
    name,
    ...(scope === "installation" ? { scope } : { ownerUserId: "u:ada" }),
  });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

async function credential(vaultId: string, key: string, auth: Record<string, unknown>) {
  const created = await post(runtime, `/v1/tenant/vaults/${vaultId}/credentials`, {
    requestId: key,
    idempotencyKey: key,
    name: key,
    auth,
  });
  expect(created.status, created.text).toBe(200);
}

beforeAll(async () => {
  [keyed, gateway, open] = await Promise.all([
    mcpServer({ requireKey: API_KEY }),
    mcpServer({ requireKey: GATEWAY_KEY }),
    mcpServer(),
  ]);
  runtime = await startTestTenant();
  refusing = await startTestTenant({ delivery: { privateAddresses: "refuse" } });
  shared = await vault("shared", "installation");
  other = await vault("other", "installation");
  ada = await vault("ada", "user");
  await credential(shared, "keyed", { type: "headers", url: keyed.url, headers: { "X-API-Key": API_KEY, "X-App-Key": APP_KEY } });
  await credential(shared, "vendor", {
    type: "headers",
    url: VENDOR_URL,
    headers: { "x-api-key": GATEWAY_KEY },
    via: gateway.url,
    identity: { header: "x-user-id" },
  });
  // The same URL in two installation vaults: a preview must be told which.
  await credential(shared, "open-a", { type: "bearer", url: open.url, token: "open-token-a-plaintext" });
  await credential(other, "open-b", { type: "bearer", url: open.url, token: "open-token-b-plaintext" });
  await credential(ada, "ada-keyed", { type: "headers", url: keyed.url, headers: { "x-api-key": "ada-key-plaintext-0000" } });
});

afterAll(async () => {
  await runtime?.close();
  await refusing?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("POST /v1/tenant/mcp/preview", () => {
  it("lists a key server's tools with the installation vault's header credential, and calls none", async () => {
    const answer = await preview({ url: keyed.url, name: "tracker" });
    expect(answer.status, answer.text).toBe(200);
    expect(McpPreviewSchema.parse(answer.body)).toEqual(answer.body);
    expect(answer.body).toMatchObject({
      name: "tracker",
      url: keyed.url,
      type: "streamable-http",
      credentialSent: true,
      serverInfo: { name: "issue-tracker", version: "1.2.3" },
    });
    expect(answer.body.instructions).toBe("Search before creating. Your key is [redacted].");
    const search = answer.body.tools.find((tool: { serverToolName: string }) => tool.serverToolName === "search");
    expect(search).toMatchObject({
      modelName: "tracker__search",
      description: "Searches issues.",
      annotations: { readOnlyHint: true, title: "Search issues" },
    });
    expect(search.schemaBytes).toBeGreaterThan(20);
    expect(answer.body.authRequired).toBeUndefined();
    for (const request of keyed.seen) {
      expect(request.headers["x-api-key"]).toBe(API_KEY);
      expect(request.headers["x-app-key"]).toBe(APP_KEY);
    }
    expect(keyed.seen.map((request) => request.method)).toContain("tools/list");
    expect(keyed.seen.map((request) => request.method)).not.toContain("tools/call");
    for (const secret of [API_KEY, APP_KEY]) expect(answer.text).not.toContain(secret);
  });

  it("renames a dotted tool name, and lists the rename", async () => {
    const answer = await preview({ url: keyed.url, name: "tracker" });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.renamed).toEqual([{ serverToolName: "issues.create", name: "tracker__issues_create" }]);
    expect(answer.body.tools).toContainEqual(
      expect.objectContaining({ serverToolName: "issues.create", modelName: "tracker__issues_create" }),
    );
  });

  it("names the server after the URL's host when the request names none", async () => {
    const answer = await preview({ url: keyed.url });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.name).toBe("127_0_0_1");
    expect(answer.body.tools).toContainEqual(expect.objectContaining({ modelName: "127_0_0_1__search" }));
  });

  it("sends a gateway credential's requests to its via, without an identity header", async () => {
    const before = gateway.seen.length;
    const answer = await preview({ url: VENDOR_URL, name: "vendor" });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.tools).toHaveLength(2);
    const requests = gateway.seen.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers["x-api-key"]).toBe(GATEWAY_KEY);
      expect(request.headers["x-user-id"]).toBeUndefined();
    }
    expect(answer.text).not.toContain(GATEWAY_KEY);
  });

  it("answers authRequired with the metadata a 401 challenge names", async () => {
    const vendor = await oauthServer({ named: true });
    const answer = await preview({ url: vendor.url, name: "vendor" });
    expect(answer.status, answer.text).toBe(200);
    expect(McpPreviewSchema.parse(answer.body)).toEqual(answer.body);
    expect(answer.body).toMatchObject({
      credentialSent: false,
      tools: [],
      renamed: [],
      authRequired: {
        resourceMetadataUrl: vendor.url.replace("/mcp", "/meta/resource.json"),
        resourceMetadata: { authorization_servers: ["https://auth.vendor.test"], scopes_supported: ["read"] },
      },
    });
    expect(vendor.fetched).toEqual(["/meta/resource.json"]);
  });

  it("reads the metadata at the well-known path when the challenge names none", async () => {
    const vendor = await oauthServer({ named: false });
    const answer = await preview({ url: vendor.url, name: "vendor" });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.authRequired).toEqual({
      resourceMetadataUrl: vendor.url.replace("/mcp", "/.well-known/oauth-protected-resource/mcp"),
      resourceMetadata: expect.objectContaining({ resource: vendor.url }),
    });
  });

  it("refuses a private address the Host's policy refuses, without reaching the server", async () => {
    const before = open.seen.length;
    const answer = await preview({ url: open.url, name: "open" }, refusing);
    expect(answer.status, answer.text).toBe(502);
    expect(answer.body).toMatchObject({
      code: "mcp_preview_failed",
      details: { failure: "mcp.unreachable" },
    });
    expect(answer.body.message).toMatch(/private addresses/);
    expect(open.seen.length).toBe(before);
  });

  it("says which vault to use when two installation vaults hold the URL, and uses the one named", async () => {
    const ambiguous = await preview({ url: open.url, name: "open" });
    expect(ambiguous.status, ambiguous.text).toBe(409);
    expect(ambiguous.body).toMatchObject({ code: "request_rejected", details: { reason: "ambiguous" } });
    const before = open.seen.length;
    const chosen = await preview({ url: open.url, name: "open", vaultId: other });
    expect(chosen.status, chosen.text).toBe(200);
    expect(chosen.body.credentialSent).toBe(true);
    for (const request of open.seen.slice(before))
      expect(request.headers.authorization).toBe("Bearer open-token-b-plaintext");
    expect(chosen.text).not.toContain("open-token-b-plaintext");
  });

  it("refuses a person's vault, a missing vault and a bad request", async () => {
    expect((await preview({ url: keyed.url, vaultId: ada })).status).toBe(400);
    expect((await preview({ url: keyed.url, vaultId: "vlt-missing" })).status).toBe(404);
    for (const body of [{}, { url: "not a url" }, { url: "ftp://x.test/mcp" }, { url: keyed.url, name: "a.b" }, { url: keyed.url, extra: 1 }]) {
      const answer = await preview(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("needs a management key: an application key is key_role_mismatch", async () => {
    const answer = await post(runtime, "/v1/tenant/mcp/preview", { url: keyed.url }, runtime.headers());
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe("key_role_mismatch");
  });
});

describe("previewMcpServer", () => {
  it("gives up on a server silent past its timeout, as mcp.unreachable", async () => {
    const silent = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const vault = {
      listVaults: async () => [],
      getVault: async () => {
        throw new Error("not called");
      },
      authorize: async () => {
        throw new Error("not called");
      },
    };
    const started = Date.now();
    const error = await previewMcpServer({ url: `${origin(silent)}/mcp` }, { vault, policy: {}, timeoutMs: 200 }).catch(
      (caught: unknown) => caught,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 502,
      rejection: { code: "mcp_preview_failed", details: { failure: "mcp.unreachable" } },
    });
    expect((error as Error).message).toMatch(/did not answer within 0.2 s/);
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  });
});

describe("previewServerName", () => {
  it("takes the host's name before its top-level domain, past mcp, www and api", () => {
    expect(previewServerName("https://mcp.linear.app/mcp")).toBe("linear");
    expect(previewServerName("https://api.githubcopilot.com/mcp/")).toBe("githubcopilot");
    expect(previewServerName("https://mcp.notion.com/mcp")).toBe("notion");
    expect(previewServerName("https://server.smithery.ai/x/mcp")).toBe("smithery");
    expect(previewServerName("http://localhost:3000/mcp")).toBe("localhost");
    expect(previewServerName("http://127.0.0.1:3000/mcp")).toBe("127_0_0_1");
    expect(previewServerName("http://[::1]:3000/mcp")).toBe("__1");
  });
});
