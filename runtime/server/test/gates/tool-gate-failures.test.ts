/**
 * R2b C7 and C8 at the Tool Gate: the gate answers a tool call's failure with a code and no
 * credential value, before it records the answer in `tool_crossings`; the loop's client turns a
 * coded answer into the failed outcome the model sees, and only a call lost with the gateway (a
 * restart) stays uncertain.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import { callMcpTool } from "../../src/mcp/connect.js";
import { createMcpHandler } from "../../src/gates/mcp-handler.js";
import { httpToolGate } from "../../src/gates/tool-client.js";
import { MCP_CONNECT_PATH, TOOL_CALLS_PATH, type McpAnswer } from "../../src/gates/tool-contract.js";
import type { TenantVaults } from "../../src/gates/tenant-vaults.js";

const TOKEN = "gate-bearer-plaintext-1234567890";
const tenantId = newTenantId();
const quiet = { info() {}, warn() {}, error() {} } as never;
const signal = new AbortController().signal;

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An MCP server whose `echo` returns the Authorization header, and whose `boom` answers 500 with it. */
async function echoServer(): Promise<string> {
  const origin = await listen(
    createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string; params?: { name?: string } };
      const authorization = req.headers.authorization ?? "";
      if (body.method === "tools/call" && body.params?.name === "boom")
        return void res.writeHead(500).end(`failed for ${authorization}`);
      const mcp = new McpServer({ name: "echo", version: "0.0.0" });
      mcp.registerTool("echo", { inputSchema: { value: z.string() } }, async () => ({
        content: [{ type: "text", text: `sent ${authorization}` }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on("close", () => void transport.close().catch(() => {}));
      await transport.handleRequest(req, res, body);
    }),
  );
  return `${origin}/mcp`;
}

describe("the gate's MCP handler", () => {
  async function handlerFor(url: string, open?: () => Promise<never>) {
    const agent = Agent({ id: "bot" }).mcp({ remote: { type: "streamable-http", url } }).build();
    const capabilityId = agent.manifest.capabilities.find((item) => item.mcpServers)!.id;
    const vaults: TenantVaults = {
      open: async () =>
        ({
          tenantId,
          session: async (id: string) => ({ id, manifest: agent.manifest }),
          authorizeMcp: async (_session: string, request: { url: string }) => ({
            status: "authorized",
            url: request.url,
            headers: { authorization: `Bearer ${TOKEN}` },
            vault: "installation",
          }),
        }) as never,
    };
    const handler = createMcpHandler({ vaults, logger: quiet, ...(open ? { open } : {}) });
    const call = (name: string, serverName = "remote") =>
      handler.call(
        undefined,
        { server: { sessionId: "s1", capabilityId, serverName }, effectId: `e-${name}`, name, arguments: { value: "x" } },
        signal,
      );
    return { handler, call };
  }

  it("answers mcp.unreachable for a call whose server cannot be opened, and stays uncoded for an undeclared one", async () => {
    const { call } = await handlerFor("https://mcp.example.invalid/mcp", async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND mcp.example.invalid"), { code: "ENOTFOUND" });
    });
    expect(await call("echo")).toMatchObject({
      ok: false,
      error: { failure: { code: "mcp.unreachable", sent: false, retryable: true } },
    });
    const undeclared = await call("echo", "nope");
    expect(undeclared).toMatchObject({ ok: false, error: { message: expect.stringContaining("not declared") } });
    expect((undeclared as { error: { failure?: unknown } }).error.failure).toBeUndefined();
  });

  it("scrubs the credential a server echoes from a result and an error before it answers", async () => {
    const { handler, call } = await handlerFor(await echoServer());
    const answered = await call("echo");
    expect(answered).toEqual({
      ok: true,
      result: { content: [{ type: "text", text: "sent [redacted]" }] },
      redacted: 1,
    });
    const failed = await call("boom");
    expect(failed).toMatchObject({
      ok: false,
      error: {
        message: "The MCP server 'remote' answered HTTP 500: failed for [redacted]",
        failure: { code: "mcp.status", sent: true, retryable: false, redacted: 1 },
      },
    });
    expect(JSON.stringify([answered, failed])).not.toContain(TOKEN);
    await handler.closeAll();
  });
});

describe("the loop's client of the gate", () => {
  /** A gate that answers each tool call as `answers` says for its tool name. */
  async function gate(answers: Record<string, McpAnswer<Record<string, unknown>>>) {
    const url = await listen(
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { name?: string };
        const answer = req.url === MCP_CONNECT_PATH ? { ok: true, result: null } : answers[body.name ?? ""];
        res.writeHead(req.url === TOOL_CALLS_PATH || req.url === MCP_CONNECT_PATH ? 200 : 404, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(answer ?? { error: { message: "unknown" } }));
      }),
    );
    const tools = httpToolGate({ url, token: "ab".repeat(32) });
    return tools.openMcp!({ sessionId: "s1", capabilityId: "mcp", serverName: "remote" });
  }

  const failure = (code: string, extra: Record<string, unknown> = {}) => ({
    ok: false as const,
    error: { message: `${code} happened`, failure: { code, message: `${code} happened`, sent: true, retryable: false, ...extra } },
  });

  it("turns a coded answer into the failed outcome the model sees", async () => {
    const connection = await gate({
      forbidden: failure("mcp.forbidden", { redacted: 1 }) as never,
      unreachable: failure("mcp.unreachable", { sent: false, retryable: true }) as never,
      rejected: failure("credential_rejected", { server: "remote", vault: "user" }) as never,
      echo: { ok: true, result: { content: [{ type: "text", text: "[redacted]" }] }, redacted: 1 },
    });
    expect(await callMcpTool(connection.client, "forbidden", {})).toEqual({
      kind: "failed",
      code: "mcp.forbidden",
      message: "mcp.forbidden happened",
      retryable: false,
      redacted: 1,
    });
    expect(await callMcpTool(connection.client, "unreachable", {})).toMatchObject({
      code: "mcp.unreachable",
      retryable: true,
    });
    expect(await callMcpTool(connection.client, "rejected", {})).toMatchObject({
      code: "credential_rejected",
      server: "remote",
      vault: "user",
      retryable: false,
    });
    expect(await callMcpTool(connection.client, "echo", {})).toEqual({
      kind: "completed",
      output: "[redacted]",
      redacted: 1,
    });
  });

  it("gives mcp.lost to the model only for a tool that is safe to call again", async () => {
    const connection = await gate({ lookup: failure("mcp.lost", { retryable: true }) as never });
    await expect(callMcpTool(connection.client, "lookup", {})).rejects.toThrow("mcp.lost happened");
    expect(await callMcpTool(connection.client, "lookup", {}, { retrySafe: true })).toMatchObject({
      kind: "failed",
      code: "mcp.lost",
      retryable: true,
    });
  });

  it("leaves a call lost with a gateway restart uncertain, even for a read-only tool", async () => {
    const connection = await gate({
      charge: {
        ok: false,
        error: {
          uncertain: true,
          message: "The gateway stopped while this tool call ran; the call may have reached its server, so it is not run again",
        },
      },
    });
    for (const retrySafe of [false, true])
      await expect(callMcpTool(connection.client, "charge", {}, { retrySafe })).rejects.toThrow(
        "the call may have run; it is not sent again",
      );
  });
});
