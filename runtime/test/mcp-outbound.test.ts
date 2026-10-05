/**
 * Remote MCP servers are reached under the Host's address policy (`tenant/outbound.ts`), as
 * Action endpoints are: in the local stack `localhost` means the Docker host, and a Host that
 * refuses private addresses refuses them for MCP too.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callMcpTool, diagnosticFromError, listMcpTools, openMcpServer } from "../src/mcp/connect.js";

// `host.docker.internal` resolves only inside Docker (or on some Docker Desktop hosts): here it
// is this machine's loopback, so a rewritten `localhost` reaches the test server.
const resolved: string[] = [];
vi.mock("node:dns", async (original) => {
  const dns = await original<typeof import("node:dns")>();
  const lookup = ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
    resolved.push(hostname);
    if (hostname === "host.docker.internal") {
      const address = { address: "127.0.0.1", family: 4 };
      return (options as { all?: boolean }).all ? callback(null, [address]) : callback(null, address.address, 4);
    }
    return dns.lookup(hostname, options as never, callback as never);
  }) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

const servers: Server[] = [];
const hosts: (string | undefined)[] = [];
beforeEach(() => {
  resolved.length = 0;
  hosts.length = 0;
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
    pluginData: "",
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
