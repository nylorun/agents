/**
 * F4.1, the Tool Gate: remote MCP servers are opened through the gate (the loop never
 * authorizes one), the gate refuses servers a session does not declare and stdio servers, and
 * deliveries keep their meaning across the hop (`not_sent` before the request reached the gate,
 * the endpoint's answer after it).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import type { LiveConnection, McpClient } from "../../src/mcp/connect.js";
import { McpPool, type McpServerRef } from "../../src/mcp/pool.js";
import { createMcpHandler } from "../../src/gates/mcp-handler.js";
import { httpToolGate } from "../../src/gates/tool-client.js";
import { DELIVERIES_PATH } from "../../src/gates/tool-contract.js";
import type { TenantVaults } from "../../src/gates/tenant-vaults.js";
import { startGates, type GatesServer } from "../../src/host/gates.js";

const realFetch = globalThis.fetch;
const token = "ef".repeat(32);
const tenantId = newTenantId();
const quiet = { info() {}, warn() {}, error() {} } as never;

const agent = Agent({ id: "bot", name: "Bot" })
  .mcp({
    github: { type: "streamable-http", url: "https://mcp.example.invalid/mcp" },
    local: { type: "stdio", command: "./server.mjs" },
  })
  .build();
const capabilityId = agent.manifest.capabilities.find((c) => c.mcpServers)!.id;

function fakeConnection(): LiveConnection & { calls: string[] } {
  const calls: string[] = [];
  const client: McpClient = {
    listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
    callTool: async (params) => {
      calls.push(params.name);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { client, calls, close: async () => {} };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe("the loop's MCP pool with a Tool Gate", () => {
  it("opens remote servers through the gate and never authorizes them itself", async () => {
    const authorize = vi.fn();
    const opened: McpServerRef[] = [];
    const local: string[] = [];
    const pool = new McpPool({
      pluginData: "/tmp/plugin-data",
      childEnv: {},
      authorize,
      open: async (input) => {
        local.push(input.server.name);
        return fakeConnection();
      },
      openRemote: async (server) => {
        opened.push(server);
        return fakeConnection();
      },
    });
    const found = await pool.discover({
      sessionId: "s1",
      manifest: agent.manifest,
      manifestHash: "h",
      pluginRoots: {},
    });
    expect(found.snapshot.mcpTools.map((tool) => tool.name).sort()).toEqual([
      "github__echo",
      "local__echo",
    ]);
    expect(opened).toEqual([{ sessionId: "s1", capabilityId, serverName: "github" }]);
    expect(local).toEqual(["local"]);
    expect(authorize).not.toHaveBeenCalled();
    await pool.close();
  });
});

describe("the gate's MCP handler", () => {
  const vaults = (manifest: unknown): TenantVaults => ({
    open: async () =>
      ({
        tenantId,
        session: async (id: string) => (id === "s1" ? { id, manifest } : undefined),
        authorizeMcp: async () => ({ status: "none" }),
      }) as never,
  });

  it("refuses a stdio server, an undeclared server and an unknown session", async () => {
    const open = vi.fn(async () => fakeConnection());
    const handler = createMcpHandler({ vaults: vaults(agent.manifest), logger: quiet, open });
    const stdio = await handler.connect(undefined, { sessionId: "s1", capabilityId, serverName: "local" });
    expect(stdio).toMatchObject({ ok: false, error: { message: expect.stringContaining("stdio") } });
    const missing = await handler.connect(undefined, { sessionId: "s1", capabilityId, serverName: "nope" });
    expect(missing).toMatchObject({ ok: false, error: { message: expect.stringContaining("not declared") } });
    const session = await handler.connect(undefined, { sessionId: "s2", capabilityId, serverName: "github" });
    expect(session).toMatchObject({ ok: false, error: { message: expect.stringContaining("not found") } });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a declared remote server once, authorized by the session's vault, and calls it", async () => {
    const connection = fakeConnection();
    const authorizeMcp = vi.fn(async () => ({ status: "none" as const }));
    const open = vi.fn(async (input: { authorize?: (url: string) => Promise<unknown> }) => {
      await input.authorize?.("https://mcp.example.invalid/mcp");
      return connection;
    });
    const handler = createMcpHandler({
      vaults: {
        open: async () =>
          ({
            tenantId,
            session: async (id: string) => ({ id, manifest: agent.manifest }),
            authorizeMcp,
          }) as never,
      },
      logger: quiet,
      open: open as never,
    });
    const server = { sessionId: "s1", capabilityId, serverName: "github" };
    expect(await handler.connect(undefined, server)).toEqual({ ok: true, result: null });
    const called = await handler.call(
      undefined,
      { server, effectId: "e1", name: "echo", arguments: {} },
      new AbortController().signal,
    );
    expect(called).toEqual({ ok: true, result: { content: [{ type: "text", text: "ok" }] } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(authorizeMcp).toHaveBeenCalledWith("s1", {
      url: "https://mcp.example.invalid/mcp",
      serverName: "github",
    });
    expect(connection.calls).toEqual(["echo"]);
    await handler.closeAll();
  });
});

describe("deliveries through the gate", () => {
  async function gate(): Promise<GatesServer> {
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: { open: async () => ({ tenantId }) as never },
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    return server;
  }

  async function endpoint(): Promise<{ url: string; seen: { headers: Record<string, unknown>; body: string }[] }> {
    const seen: { headers: Record<string, unknown>; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "application/json", "x-reply": "yes" });
        res.end(JSON.stringify({ answered: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/actions`, seen };
  }

  it("POSTs the signed delivery and returns the endpoint's answer", async () => {
    const server = await gate();
    const target = await endpoint();
    const tools = httpToolGate({ url: server.url, token });
    const result = await tools.post(
      {
        url: target.url,
        body: JSON.stringify({ type: "ping" }),
        headers: { "Nylorun-Signature": "signed", "idempotency-key": "a1" },
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(200);
    expect(result.headers["x-reply"]).toBe("yes");
    expect(JSON.parse(result.body.toString())).toEqual({ answered: true });
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0]!.headers["nylorun-signature"]).toBe("signed");
    expect(target.seen[0]!.headers["idempotency-key"]).toBe("a1");
    expect(target.seen[0]!.body).toBe(JSON.stringify({ type: "ping" }));
  });

  it("refuses a header that is not part of a delivery", async () => {
    const server = await gate();
    const response = await realFetch(new URL(DELIVERIES_PATH, server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://127.0.0.1:9/x",
        body: "{}",
        headers: { cookie: "a=b" },
        timeoutMs: 1_000,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("applies the gateway's address policy, not the caller's", async () => {
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: { open: async () => ({ tenantId }) as never },
      delivery: { privateAddresses: "refuse" },
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    const target = await endpoint();
    const result = await httpToolGate({ url: server.url, token }).post(
      { url: target.url, body: "{}", headers: {}, timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "not_sent", code: "ENDPOINT_ADDRESS_REFUSED" });
    expect(target.seen).toHaveLength(0);
  });

  it("is not_sent when the gate is unreachable or refuses the token", async () => {
    const down = httpToolGate({ url: "http://127.0.0.1:9", token });
    expect(
      await down.post({ url: "http://127.0.0.1:9/x", body: "{}", headers: {}, timeoutMs: 1_000 }, new AbortController().signal),
    ).toMatchObject({ kind: "not_sent", code: "gateway.unreachable" });
    const server = await gate();
    const wrong = httpToolGate({ url: server.url, token: "00".repeat(32) });
    expect(
      await wrong.post({ url: "http://127.0.0.1:9/x", body: "{}", headers: {}, timeoutMs: 1_000 }, new AbortController().signal),
    ).toMatchObject({ kind: "not_sent", code: "gateway.refused" });
  });
});
