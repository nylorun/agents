/**
 * Remote MCP servers are reached under the Host's address policy (`tenant/outbound.ts`), as
 * HTTP tools are: in the local stack `localhost` means the Docker host, and a Host that
 * refuses private addresses refuses them for MCP too.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import { callMcpTool, diagnosticFromError, listMcpTools, openMcpServer } from "../src/mcp/connect.js";
import { McpPool } from "../src/mcp/pool.js";

// `host.docker.internal` resolves only inside Docker (or on some Docker Desktop hosts): here it
// is this machine's loopback, so a rewritten `localhost` reaches the test server.
const resolved: string[] = [];
vi.mock("node:dns", async (original) => {
  const dns = await original<typeof import("node:dns")>();
  const lookup = ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
    resolved.push(hostname);
    // `flaky.test` is this machine until its name stops resolving.
    if (hostname === "flaky.test" && resolver.down)
      return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    if (hostname === "host.docker.internal" || hostname === "flaky.test") {
      const address = { address: "127.0.0.1", family: 4 };
      return (options as { all?: boolean }).all ? callback(null, [address]) : callback(null, address.address, 4);
    }
    return dns.lookup(hostname, options as never, callback as never);
  }) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});
const resolver = { down: false };

const servers: Server[] = [];
const hosts: (string | undefined)[] = [];
beforeEach(() => {
  resolved.length = 0;
  hosts.length = 0;
  resolver.down = false;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function serveMcp(): Promise<number> {
  const http = createServer(async (req, res) => {
    hosts.push(req.headers.host);
    if (req.method !== "POST") return void res.writeHead(405).end();
    const mcp = new McpServer({ name: "local", version: "0.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echo.", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    // Answers stream as SSE: the body arrives after the headers.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, await json(req));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push(http);
  return (http.address() as { port: number }).port;
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const open = (url: string, policy: Parameters<typeof openMcpServer>[0]["policy"]) =>
  openMcpServer({
    server: { name: "local", type: "streamable-http", url },
    authorize: async (url) => ({ status: "unauthenticated", url, headers: {} }),
    policy,
  });

it("reaches a localhost server on the Docker host in the local stack, and streams its answers", async () => {
  const port = await serveMcp();
  const connection = await open(`http://localhost:${port}/mcp`, { loopback: "docker-host" });
  try {
    const listed = await listMcpTools(connection.client, {
      capabilityId: "mcp",
      serverName: "local",
      taken: new Set(),
    });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["local__echo"]);
    expect(await callMcpTool(connection.client, "echo", { text: "hi" })).toEqual({
      kind: "completed",
      output: "hi",
    });
  } finally {
    await connection.close();
  }
  expect(resolved).toContain("host.docker.internal");
  expect(resolved).not.toContain("localhost");
  // The server sees the URL it was declared with.
  expect(new Set(hosts)).toEqual(new Set([`localhost:${port}`]));
});

it("connects to localhost itself without the docker-host policy", async () => {
  const port = await serveMcp();
  const connection = await open(`http://localhost:${port}/mcp`, {});
  await connection.close();
  expect(resolved).not.toContain("host.docker.internal");
  expect(hosts.length).toBeGreaterThan(0);
});

it("refuses private addresses when the Host does, before connecting", async () => {
  const port = await serveMcp();
  for (const url of [`http://127.0.0.1:${port}/mcp`, `http://localhost:${port}/mcp`]) {
    const error = await open(url, { privateAddresses: "refuse" }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error, url).toBeDefined();
    expect(diagnosticFromError("mcp", "local", error).message).toMatch(/private addresses/);
  }
  expect(hosts).toEqual([]);
});

it("says why a server could not be reached instead of 'fetch failed'", async () => {
  const closed = await serveMcp();
  await new Promise((resolve) => servers.pop()!.close(resolve));
  const error = await open(`http://127.0.0.1:${closed}/mcp`, {}).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(diagnosticFromError("mcp", "local", error).message).toMatch(/ECONNREFUSED/);
});

describe("a call that never reached its server (R2b C7)", () => {
  /**
   * Connects to a fresh server at `host`, lists its tools, and drops the idle sockets, so the
   * call that follows opens a new one (a reused socket the server just closed is a lost call).
   */
  async function connected(host: string) {
    const port = await serveMcp();
    const connection = await open(`http://${host}:${port}/mcp`, {});
    await listMcpTools(connection.client, { capabilityId: "mcp", serverName: "local", taken: new Set() });
    const server = servers.at(-1)!;
    server.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { connection, server };
  }

  it("is mcp.unreachable when the server's name no longer resolves", async () => {
    const { connection } = await connected("flaky.test");
    resolver.down = true;
    try {
      expect(await callMcpTool(connection.client, "echo", { text: "hi" })).toMatchObject({
        kind: "failed",
        code: "mcp.unreachable",
        retryable: true,
        message: expect.stringContaining("ENOTFOUND"),
      });
    } finally {
      await connection.close();
    }
  });

  it("is mcp.unreachable when the connection is refused", async () => {
    const { connection, server } = await connected("127.0.0.1");
    servers.pop();
    await new Promise((resolve) => server.close(resolve));
    try {
      expect(await callMcpTool(connection.client, "echo", { text: "hi" })).toMatchObject({
        kind: "failed",
        code: "mcp.unreachable",
        retryable: true,
        message: expect.stringContaining("ECONNREFUSED"),
      });
    } finally {
      await connection.close();
    }
  });

  it("is mcp.unreachable when the pool cannot open the server's connection", async () => {
    resolver.down = true;
    const agent = Agent({ id: "bot" })
      .mcp({ local: { type: "streamable-http", url: "http://flaky.test:9/mcp" } })
      .build();
    const pool = new McpPool({
      authorize: async (_session, { url }) => ({ status: "unauthenticated", url, headers: {} }),
    });
    const outcome = await pool.call({
      sessionId: "s1",
      capabilityId: agent.manifest.capabilities.find((capability) => capability.mcpServers)!.id,
      serverName: "local",
      serverToolName: "echo",
      args: {},
      manifest: agent.manifest,
    });
    expect(outcome).toMatchObject({ kind: "failed", code: "mcp.unreachable", retryable: true });
    await pool.close();
  });
});
