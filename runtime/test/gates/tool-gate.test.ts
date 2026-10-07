/**
 * F4.1, the Tool Gate: remote MCP servers are opened through the gate (the loop never
 * authorizes one), the gate refuses servers a session does not declare, and HTTP tool calls
 * cross it (R2 M3).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import type { LiveConnection, McpClient } from "../../src/mcp/connect.js";
import { McpPool, type McpServerRef } from "../../src/mcp/pool.js";
import { createMcpHandler } from "../../src/gates/mcp-handler.js";
import { httpToolGate } from "../../src/gates/tool-client.js";
import {
  HTTP_CALLS_PATH,
  MCP_CONNECT_PATH,
  TOOL_CALLS_PATH,
} from "../../src/gates/tool-contract.js";
import type { TenantVaults } from "../../src/gates/tenant-vaults.js";
import { startGates, type GatesServer } from "../../src/host/gates.js";
import { createRunGrants } from "../../src/tenant/run-grants.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

const realFetch = globalThis.fetch;
const token = "ef".repeat(32);
const tenantId = newTenantId();
const quiet = { info() {}, warn() {}, error() {} } as never;

const agent = Agent({ id: "bot", name: "Bot" })
  .mcp({
    github: { type: "streamable-http", url: "https://mcp.example.invalid/mcp" },
    docs: { type: "sse", url: "https://docs.example.invalid/sse" },
  })
  .build();
const capabilityId = agent.manifest.capabilities.find((c) => c.mcpServers)!.id;

function fakeConnection(): LiveConnection & { calls: string[] } {
  const calls: string[] = [];
  const client: McpClient = {
    listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
    callTool: async (params) => {
      calls.push(params.name);
      return { result: { content: [{ type: "text", text: "ok" }] } };
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
    const inProcess: string[] = [];
    const pool = new McpPool({
      authorize,
      open: async (input) => {
        inProcess.push(input.server.name);
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
    });
    expect(found.snapshot.mcpTools.map((tool) => tool.name).sort()).toEqual([
      "docs__echo",
      "github__echo",
    ]);
    expect(opened).toEqual([
      { sessionId: "s1", capabilityId, serverName: "github" },
      { sessionId: "s1", capabilityId, serverName: "docs" },
    ]);
    expect(inProcess).toEqual([]);
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

  it("refuses an undeclared server and an unknown session", async () => {
    const open = vi.fn(async () => fakeConnection());
    const handler = createMcpHandler({ vaults: vaults(agent.manifest), logger: quiet, open });
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

describe("a session's MCP requests under its run token (F5)", () => {
  let runs: RunFixture;
  beforeAll(async () => {
    runs = await runFixture();
  });

  /** A gate whose MCP servers are held fakes: each open authorizes, as the real one does. */
  async function gate() {
    const authorizeMcp = vi.fn(async (_sessionId: string) => ({ status: "none" as const }));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    let upstream: AbortSignal | undefined;
    const open = vi.fn(async (input: { authorize?: (url: string) => Promise<unknown> }) => {
      await input.authorize?.("https://mcp.example.invalid/mcp");
      const client: McpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (_params, request) => {
          calls += 1;
          upstream = request?.signal;
          await Promise.race([
            released,
            new Promise((resolve) => request?.signal?.addEventListener("abort", resolve, { once: true })),
          ]);
          return { result: { content: [{ type: "text", text: "ok" }] } };
        },
      };
      return { client, close: async () => {} };
    });
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: {
        open: async () =>
          ({
            tenantId: runs.tenantId,
            store: runs.store,
            session: (id: string) => runs.store.tx((t) => t.get("sessions", id)),
            authorizeMcp,
          }) as never,
      },
      openMcp: open as never,
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    return { server, authorizeMcp, release, calls: () => calls, upstream: () => upstream };
  }

  const send = (url: string, path: string, bearer: string | undefined, body: unknown, key?: string) =>
    realFetch(new URL(path, url), {
      method: "POST",
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("opens the token's session's server; the client names no session", async () => {
    const { server, authorizeMcp, release } = await gate();
    release();
    const mine = await runs.run("mcp-a", { manifest: agent.manifest });
    const tools = httpToolGate({ url: server.url, token, runTokens: runs.grants });
    const connection = await tools.openMcp!({ sessionId: "mcp-a", capabilityId, serverName: "github" });
    expect(await connection.client.callTool({ name: "echo", arguments: {} })).toBeDefined();
    expect(authorizeMcp).toHaveBeenCalledWith("mcp-a", expect.anything());
    expect(mine.claims.sessionId).toBe("mcp-a");
  });

  it("refuses a run token naming another session, and a stale or missing one", async () => {
    const { server, authorizeMcp } = await gate();
    const mine = await runs.run("mcp-b", { manifest: agent.manifest });
    await runs.run("mcp-c", { manifest: agent.manifest });
    const theirs = { sessionId: "mcp-c", capabilityId, serverName: "github" };
    const forbidden = await send(server.url, MCP_CONNECT_PATH, mine.token, { server: theirs });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "gate_forbidden" } });
    const call = { server: theirs, effectId: "e-c", name: "echo", arguments: {} };
    expect((await send(server.url, TOOL_CALLS_PATH, mine.token, call)).status).toBe(403);
    expect((await send(server.url, MCP_CONNECT_PATH, undefined, { server: theirs })).status).toBe(401);
    expect(authorizeMcp).not.toHaveBeenCalled();
    await runs.takeOver("mcp-b");
    const { sessionId: _, ...unnamed } = theirs;
    const stale = await send(server.url, MCP_CONNECT_PATH, mine.token, { server: unnamed });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "run_stale" } });
    expect(authorizeMcp).not.toHaveBeenCalled();
  });

  it("serves core's credential outside a run, with the session in the body", async () => {
    const { server, authorizeMcp } = await gate();
    await runs.run("mcp-d", { manifest: agent.manifest });
    const ref = { capabilityId, serverName: "github" };
    const unnamed = await send(server.url, MCP_CONNECT_PATH, token, { server: ref });
    expect(unnamed.status).toBe(400);
    const named = await send(server.url, MCP_CONNECT_PATH, token, { server: { ...ref, sessionId: "mcp-d" } });
    expect(await named.json()).toEqual({ ok: true, result: null });
    expect(authorizeMcp).toHaveBeenCalledWith("mcp-d", expect.anything());
    // Without a grant the client falls back to core's credential.
    const tools = httpToolGate({ url: server.url, token, runTokens: createRunGrants() });
    await expect(tools.openMcp!({ sessionId: "mcp-d", capabilityId, serverName: "github" })).resolves.toBeDefined();
  });

  it("refuses a keyed cancel of another session's call", async () => {
    const held = await gate();
    const mine = await runs.run("mcp-e", { manifest: agent.manifest });
    const theirs = await runs.run("mcp-f", { manifest: agent.manifest });
    const key = "turn-1:0:tool:e";
    const call = { server: { capabilityId, serverName: "github" }, effectId: key, name: "echo", arguments: {} };
    const running = send(held.server.url, TOOL_CALLS_PATH, mine.token, call, key);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    // Another session's re-send under the same key hashes differently: it never joins.
    const joined = await send(held.server.url, TOOL_CALLS_PATH, theirs.token, call, key);
    expect(joined.status).toBe(409);
    const cancelPath = `${TOOL_CALLS_PATH}/${encodeURIComponent(key)}/cancel`;
    const forbidden = await send(held.server.url, cancelPath, theirs.token, undefined);
    expect(forbidden.status).toBe(403);
    expect(held.upstream()?.aborted).toBe(false);
    const tools = httpToolGate({ url: held.server.url, token, runTokens: runs.grants });
    await tools.cancel!({ tenantId: runs.tenantId, sessionId: "mcp-e", effectId: key });
    await vi.waitFor(() => expect(held.upstream()?.aborted).toBe(true));
    held.release();
    await running;
    expect(held.calls()).toBe(1);
  });
});

describe("HTTP tool calls through the gate (R2 M3)", () => {
  let runs: RunFixture;
  beforeAll(async () => {
    runs = await runFixture();
  });

  async function service(): Promise<{ url: string; seen: Record<string, unknown>[] }> {
    const seen: Record<string, unknown>[] = [];
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/refunds`, seen };
  }

  async function gate() {
    const authorizeMcp = vi.fn(async (_sessionId: string, request: { url: string }) => ({
      status: "authorized" as const,
      url: request.url,
      headers: { authorization: "Bearer vaulted" },
    }));
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: {
        open: async () =>
          ({
            tenantId: runs.tenantId,
            store: runs.store,
            session: (id: string) => runs.store.tx((t) => t.get("sessions", id)),
            authorizeMcp,
          }) as never,
      },
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    return { server, authorizeMcp };
  }

  const billing = (url: string) =>
    Agent({ id: "bot", name: "Bot" })
      .tools(http({ name: "refund", input: z.object({ id: z.string() }), url, credential: "billing" }))
      .build();
  const capabilityOf = (agent: ReturnType<typeof billing>) =>
    agent.manifest.capabilities.find((c) => c.tools?.some((tool) => tool.name === "refund"))!.id;

  it("calls the tool the token's session declares, with its vault credential and the token's turn", async () => {
    const target = await service();
    const { server, authorizeMcp } = await gate();
    const agent = billing(target.url);
    const grant = await runs.run("http-a", { manifest: agent.manifest });
    const tools = httpToolGate({ url: server.url, token, runTokens: runs.grants });
    const outcome = await tools.callHttp!(
      {
        tool: { sessionId: "http-a", capabilityId: capabilityOf(agent), toolName: "refund" },
        effectId: "turn-x:0:tool:1",
        turnId: "ignored-under-a-run-token",
        input: { id: "A-1" },
      },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "completed", output: { ok: true } });
    expect(authorizeMcp).toHaveBeenCalledWith("http-a", {
      url: target.url,
      serverName: "billing",
    });
    expect(target.seen).toEqual([
      expect.objectContaining({
        authorization: "Bearer vaulted",
        "idempotency-key": "turn-x:0:tool:1",
        "nylorun-session-id": "http-a",
        "nylorun-turn-id": grant.claims.turnId,
        "nylorun-agent-id": "bot",
      }),
    ]);
  });

  it("refuses another session's tool under a run token, and an undeclared tool is a tool error", async () => {
    const target = await service();
    const { server } = await gate();
    const agent = billing(target.url);
    const mine = await runs.run("http-b", { manifest: agent.manifest });
    await runs.run("http-c", { manifest: agent.manifest });
    const body = (sessionId: string | undefined, toolName = "refund") => ({
      tool: { ...(sessionId ? { sessionId } : {}), capabilityId: capabilityOf(agent), toolName },
      effectId: "e",
      turnId: "t",
      input: {},
    });
    const send = (bearer: string, value: unknown) =>
      realFetch(new URL(HTTP_CALLS_PATH, server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await send(mine.token, body("http-c"))).status).toBe(403);
    expect((await send(token, body(undefined))).status).toBe(400);
    expect(await (await send(mine.token, body(undefined, "nope"))).json()).toEqual({
      ok: true,
      result: { kind: "failed", code: "http.undeclared", message: "'nope' is not an HTTP tool of the session" },
    });
    expect(target.seen).toEqual([]);
  });
});
