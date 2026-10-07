/**
 * R2b C7: a pooled MCP connection that can no longer make requests is dropped, opened again,
 * and the call sent once more, since the tool never saw it: a server that ended the connection's
 * session (`404` to its `Mcp-Session-Id`, MCP 2025-06-18 "Session Management"), or a credential
 * whose `via` now sends the server's requests elsewhere. In the loop's pool (in process) and in
 * the gate's MCP handler alike.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import { McpPool } from "../src/mcp/pool.js";
import { createMcpHandler } from "../src/gates/mcp-handler.js";
import type { TenantVaults } from "../src/gates/tenant-vaults.js";
import type { AuthorizeResult } from "../src/vault/service.js";

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A stateful MCP server with one `echo` tool. Each `initialize` starts a session; a request
 * naming any other session is `404`. `expire()` ends the current one; with `endEveryCall` each
 * `tools/call` finds its session gone.
 */
async function sessionServer(options: { endEveryCall?: boolean } = {}) {
  let generation = 0;
  let current: string | undefined;
  const counts = { initialize: 0, calls: 0, ran: 0 };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(req.method === "DELETE" ? 200 : 405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
    if (body.method === "initialize") {
      counts.initialize += 1;
      current = `session-${(generation += 1)}`;
      return json(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "stateful", version: "0.0.0" },
          },
        },
        { "mcp-session-id": current },
      );
    }
    if (body.method === "tools/call") {
      counts.calls += 1;
      if (options.endEveryCall) current = undefined;
    }
    if (req.headers["mcp-session-id"] !== current || current === undefined)
      return json(404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    if (body.id === undefined) return void res.writeHead(202).end();
    if (body.method === "tools/list")
      return json(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
    counts.ran += 1;
    return json(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ran in ${current}` }] } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    counts,
    expire: () => {
      current = undefined;
    },
  };
}

const agentFor = (url: string) =>
  Agent({ id: "bot" }).mcp({ remote: { type: "streamable-http", url } }).build().manifest;
const capabilityOf = (manifest: ReturnType<typeof agentFor>) =>
  manifest.capabilities.find((capability) => capability.mcpServers)!.id;

/** A pool whose server's credential sends requests to `via()`. */
function poolFor(via?: () => string) {
  return new McpPool({
    authorize: async (_session, { url }): Promise<AuthorizeResult> =>
      via
        ? { status: "authorized", url, headers: {}, via: via(), vault: "installation" }
        : { status: "unauthenticated", url, headers: {} },
  });
}

async function callThrough(pool: McpPool, manifest: ReturnType<typeof agentFor>) {
  return pool.call({
    sessionId: "s1",
    capabilityId: capabilityOf(manifest),
    serverName: "remote",
    serverToolName: "echo",
    args: {},
    manifest,
  });
}

describe("the loop's pool", () => {
  it("opens a new session when the server ended the connection's, and calls the tool once", async () => {
    const remote = await sessionServer();
    const manifest = agentFor(remote.url);
    const pool = poolFor();
    await pool.discover({ sessionId: "s1", manifest, manifestHash: "h" });
    expect(await callThrough(pool, manifest)).toEqual({ kind: "completed", output: "ran in session-1" });
    remote.expire();
    expect(await callThrough(pool, manifest)).toEqual({ kind: "completed", output: "ran in session-2" });
    expect(remote.counts).toEqual({ initialize: 2, calls: 3, ran: 2 });
    // The new connection stays in the pool.
    expect(await callThrough(pool, manifest)).toEqual({ kind: "completed", output: "ran in session-2" });
    expect(remote.counts.initialize).toBe(2);
    await pool.close();
  });

  it("sends the call once more only: a session that ends again is mcp.unreachable", async () => {
    const remote = await sessionServer({ endEveryCall: true });
    const manifest = agentFor(remote.url);
    const pool = poolFor();
    expect(await callThrough(pool, manifest)).toMatchObject({
      kind: "failed",
      code: "mcp.unreachable",
      retryable: true,
      message: expect.stringContaining("ended the connection's session (HTTP 404)"),
    });
    expect(remote.counts).toEqual({ initialize: 2, calls: 2, ran: 0 });
    await pool.close();
  });

  it("opens the connection again when the credential's via sends the server elsewhere", async () => {
    const [first, second] = await Promise.all([sessionServer(), sessionServer()]);
    let via = first.url;
    const manifest = agentFor("https://vendor.test/mcp");
    const pool = poolFor(() => via);
    expect(await callThrough(pool, manifest)).toEqual({ kind: "completed", output: "ran in session-1" });
    via = second.url;
    expect(await callThrough(pool, manifest)).toEqual({ kind: "completed", output: "ran in session-1" });
    expect(first.counts).toMatchObject({ calls: 1, ran: 1 });
    expect(second.counts).toEqual({ initialize: 1, calls: 1, ran: 1 });
    await pool.close();
  });
});

describe("the gate's MCP handler", () => {
  it("opens a new session when the server ended the connection's, and calls the tool once", async () => {
    const remote = await sessionServer();
    const manifest = agentFor(remote.url);
    const vaults: TenantVaults = {
      open: async () =>
        ({
          tenantId: newTenantId(),
          session: async (id: string) => ({ id, manifest }),
          authorizeMcp: async (_session: string, request: { url: string }) => ({
            status: "unauthenticated",
            url: request.url,
            headers: {},
          }),
        }) as never,
    };
    const handler = createMcpHandler({ vaults, logger: { info() {}, warn() {}, error() {} } as never });
    const call = (effectId: string) =>
      handler.call(
        undefined,
        { server: { sessionId: "s1", capabilityId: capabilityOf(manifest), serverName: "remote" }, effectId, name: "echo", arguments: {} },
        new AbortController().signal,
      );
    expect(await call("e1")).toEqual({ ok: true, result: { content: [{ type: "text", text: "ran in session-1" }] } });
    remote.expire();
    expect(await call("e2")).toEqual({ ok: true, result: { content: [{ type: "text", text: "ran in session-2" }] } });
    expect(remote.counts).toEqual({ initialize: 2, calls: 3, ran: 2 });
    expect(handler.size).toBe(1);
    await handler.closeAll();
  });
});
