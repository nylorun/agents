/**
 * The Runtime never asks a Streamable HTTP server for its optional event stream (a GET without
 * `Last-Event-ID`). A stateless server that answers that GET 200 and closes the stream at once
 * (the gateways' `apps` edge did) made the MCP SDK reconnect every second for as long as the
 * pool held the connection, each reconnect reading the vault and auditing `credential.used`.
 */
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { callMcpTool, listMcpTools, openMcpServer, optionalEventStream } from "../src/mcp/connect.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A stateless server built as the gateways' edge was: a server and transport per request, closed
 * as soon as the request is handled, GET included, so a GET's event stream ends before any event.
 */
async function closingServer() {
  const methods: string[] = [];
  const handle = async (request: Request): Promise<Response> => {
    const mcp = new McpServer({ name: "apps", version: "0.0.0" });
    mcp.registerTool("echo", { description: "Echo.", inputSchema: { text: z.string() } }, async ({ text }) => ({
      content: [{ type: "text", text }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      void mcp.close().catch(() => undefined);
    }
  };
  const http = createServer(async (req, res) => {
    methods.push(req.method ?? "?");
    const body = req.method === "POST" ? await text(req) : undefined;
    const answer = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) for await (const chunk of answer.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push(http);
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, methods };
}

async function text(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

it("never opens the event stream, so an idle connection sends nothing and reads no credential", async () => {
  const { url, methods } = await closingServer();
  let reads = 0;
  const connection = await openMcpServer({
    server: { name: "apps", type: "streamable-http", url },
    authorize: async (target) => {
      reads += 1;
      return { status: "authorized", url: target, headers: { authorization: "Bearer key" } };
    },
    errorExcerptChars: RUNTIME_LIMIT_DEFAULTS.errorExcerptChars,
  });
  try {
    const listed = await listMcpTools(connection.client, { serverName: "apps" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(await callMcpTool(connection.client, "echo", { text: "hi" }, { maxResultBytes: RUNTIME_LIMIT_DEFAULTS.toolAnswerBytes })).toEqual({
      kind: "completed",
      output: "hi",
    });
    // Idle, as a pooled connection between turns: the SDK reconnected a closed stream every 1 s.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  } finally {
    await connection.close();
  }
  expect(methods.filter((method) => method === "GET")).toEqual([]);
  // One read when the connection opens, then one per request sent: initialize, initialized,
  // tools/list and tools/call.
  expect(methods).toEqual(["POST", "POST", "POST", "POST"]);
  expect(reads).toBe(1 + methods.length);
});

describe("optionalEventStream", () => {
  const streamable = { type: "streamable-http" as const };
  it("declines a GET without Last-Event-ID", () => {
    expect(optionalEventStream(streamable, { method: "GET", headers: { accept: "text/event-stream" } })).toBe(true);
    expect(optionalEventStream(streamable, undefined)).toBe(true);
  });
  it("sends a GET that resumes a stream, every POST and DELETE, and a legacy sse server's GET", () => {
    expect(optionalEventStream(streamable, { method: "GET", headers: { "last-event-id": "e-7" } })).toBe(false);
    expect(optionalEventStream(streamable, { method: "GET", headers: new Headers({ "Last-Event-ID": "e-7" }) })).toBe(false);
    expect(optionalEventStream(streamable, { method: "POST" })).toBe(false);
    expect(optionalEventStream(streamable, { method: "DELETE" })).toBe(false);
    expect(optionalEventStream({ type: "sse" }, { method: "GET" })).toBe(false);
  });
});
