/**
 * An MCP server that failed at a session's first discovery is tried again at each later turn's
 * first segment, and rejoins the session's snapshot once it answers (`prepareMcp`): its tools are
 * offered from that turn on, its diagnostic replaced, and `mcp.discovered` names it again.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy } from "./support/agents.js";

const APP = "mcp-rejoin-app-key-aaaaaaaaaaaaaaa";

/** An MCP server that answers `503` until `up` is set, then lists `ping`. */
async function flakyServer() {
  const state = { up: false };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!state.up) return void res.writeHead(503, { "content-type": "text/plain" }).end("starting");
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const mcp = new McpServer({ name: "flaky", version: "0.0.0" });
    mcp.registerTool("ping", { description: "Pings.", inputSchema: { value: z.string() } }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

/** The tool names each model call offered. */
const offered: string[][] = [];
const model: ModelProvider = async (effect) => {
  const input = effect.input as { tools?: { name: string }[] };
  offered.push((input.tools ?? []).map((tool) => tool.name));
  return { output: [{ type: "text", text: "ok" }] };
};

let flaky: Awaited<ReturnType<typeof flakyServer>>;
let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let client: AgentsClient;
const servers: Server[] = [];

beforeAll(async () => {
  flaky = await flakyServer();
  servers.push(flaky.server);
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await deploy(
    runtime.url,
    runtime.headers(),
    Agent({ id: "rejoin" }).instructions("Answer.").mcp({ flaky: { type: "streamable-http", url: flaky.url } }).build(),
  );
});

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function turn(session: Awaited<ReturnType<AgentsClient["createSession"]>>, key: string) {
  await session.input("go", { idempotencyKey: key });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["completed", "failed"].includes(view.status)) return view as Record<string, any>;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

it("tries a server that failed at the first discovery again at the next turn, and offers its tools once it answers", async () => {
  const session = await client.createSession({ id: "r1", agent: "rejoin", ownerUserId: "u:ada" });
  const first = await turn(session, "m1");
  expect(first.status).toBe("completed");
  expect(offered.at(-1)).not.toContain("flaky__ping");
  expect(first.mcpSnapshot.servers).toEqual([]);
  expect(first.mcpDiagnostics).toEqual([expect.objectContaining({ serverName: "flaky", outcome: "failed" })]);

  // Still down: tried again, and still not offered.
  const second = await turn(session, "m2");
  expect(second.status).toBe("completed");
  expect(offered.at(-1)).not.toContain("flaky__ping");

  flaky.state.up = true;
  const third = await turn(session, "m3");
  expect(third.status).toBe("completed");
  expect(offered.at(-1)).toContain("flaky__ping");
  expect(third.mcpSnapshot.servers).toEqual([expect.objectContaining({ name: "flaky", tools: [expect.objectContaining({ name: "ping" })] })]);
  expect(third.mcpDiagnostics).toEqual([expect.objectContaining({ serverName: "flaky", outcome: "connected" })]);
  const history = (await session.history()).items as { type: string; payload: any }[];
  const discovered = history.filter((item) => item.type === "mcp.discovered").map((item) => item.payload);
  expect(discovered).toEqual([
    { servers: [expect.objectContaining({ serverName: "flaky", outcome: "failed", tools: 0 })] },
    { servers: [expect.objectContaining({ serverName: "flaky", outcome: "connected", tools: 1 })], rejoined: true },
  ]);

  // Joined: the next turn offers it without discovering it again.
  await turn(session, "m4");
  expect(offered.at(-1)).toContain("flaky__ping");
});
