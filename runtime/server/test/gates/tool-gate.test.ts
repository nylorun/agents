/**
 * F4.1, the Tool Gate: remote MCP servers are opened through the gate (the loop never
 * authorizes one), the gate refuses servers a session does not declare, and HTTP tool calls
 * cross it (R2 M3).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/core/define";
import { newTenantId } from "@nylorun/core/compatibility";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
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
import { noLimitsStore } from "../support/limits.js";
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
      maxInstructionBytes: RUNTIME_LIMIT_DEFAULTS.recordEntryBytes,
    });
    expect(found.snapshot.servers.map((server) => `${server.name}/${server.tools.map((tool) => tool.name)}`).sort()).toEqual([
      "docs/echo",
      "github/echo",
    ]);
    expect(opened).toEqual([
      { sessionId: "s1", serverName: "github" },
      { sessionId: "s1", serverName: "docs" },
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
        store: noLimitsStore,
        session: async (id: string) => (id === "s1" ? { id, manifest } : undefined),
        authorizeMcp: async () => ({ status: "none" }),
      }) as never,
  });

  it("refuses an undeclared server and an unknown session", async () => {
    const open = vi.fn(async () => fakeConnection());
    const handler = createMcpHandler({ vaults: vaults(agent.manifest), logger: quiet, open });
    const missing = await handler.connect(undefined, { sessionId: "s1", serverName: "nope" });
    expect(missing).toMatchObject({ ok: false, error: { message: expect.stringContaining("not declared") } });
    const session = await handler.connect(undefined, { sessionId: "s2", serverName: "github" });
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
            store: noLimitsStore,
            session: async (id: string) => ({ id, manifest: agent.manifest }),
            authorizeMcp,
          }) as never,
      },
      logger: quiet,
      open: open as never,
    });
    const server = { sessionId: "s1", serverName: "github" };
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
    const key = "turn-1:0:tool:a";
    await runs.journal("mcp-a", {
      effectId: key,
      toolName: "github__echo",
      input: {},
      mcp: { serverName: "github", serverToolName: "echo" },
    });
    const tools = httpToolGate({ url: server.url, token, runTokens: runs.grants });
    const connection = await tools.openMcp!({ sessionId: "mcp-a", serverName: "github" });
    expect(await connection.client.callTool({ name: "echo", arguments: {} }, { key })).toBeDefined();
    expect(authorizeMcp).toHaveBeenCalledWith("mcp-a", expect.anything());
    expect(mine.claims.sessionId).toBe("mcp-a");
  });

  it("sends only the server and tool the journaled call's target names (protocol 15)", async () => {
    const { server, release } = await gate();
    release();
    const mine = await runs.run("mcp-g", { manifest: agent.manifest });
    const key = "turn-1:0:tool:g";
    await runs.journal("mcp-g", {
      effectId: key,
      toolName: "github__echo",
      input: {},
      mcp: { serverName: "github", serverToolName: "echo" },
    });
    // The model's name is not the tool's identity, and neither is another server's tool.
    for (const call of [
      { server: { serverName: "github" }, effectId: key, name: "github__echo", arguments: {} },
      { server: { serverName: "docs" }, effectId: key, name: "echo", arguments: {} },
      { server: { serverName: "github", agentId: "helper" }, effectId: key, name: "echo", arguments: {} },
    ]) {
      const refused = await send(server.url, TOOL_CALLS_PATH, mine.token, call, key);
      expect(refused.status, JSON.stringify(call)).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "effect_not_journaled" } });
    }
    const call = { server: { serverName: "github" }, effectId: key, name: "echo", arguments: {} };
    expect((await send(server.url, TOOL_CALLS_PATH, mine.token, call, key)).status).toBe(200);
  });

  it("refuses a run token naming another session, and a stale or missing one", async () => {
    const { server, authorizeMcp } = await gate();
    const mine = await runs.run("mcp-b", { manifest: agent.manifest });
    await runs.run("mcp-c", { manifest: agent.manifest });
    const theirs = { sessionId: "mcp-c", serverName: "github" };
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
    const ref = { serverName: "github" };
    const unnamed = await send(server.url, MCP_CONNECT_PATH, token, { server: ref });
    expect(unnamed.status).toBe(400);
    const named = await send(server.url, MCP_CONNECT_PATH, token, { server: { ...ref, sessionId: "mcp-d" } });
    expect(await named.json()).toEqual({ ok: true, result: null });
    expect(authorizeMcp).toHaveBeenCalledWith("mcp-d", expect.anything());
    // Without a grant the client falls back to core's credential.
    const tools = httpToolGate({ url: server.url, token, runTokens: createRunGrants() });
    await expect(tools.openMcp!({ sessionId: "mcp-d", serverName: "github" })).resolves.toBeDefined();
  });

  it("refuses a keyed cancel of another session's call", async () => {
    const held = await gate();
    const mine = await runs.run("mcp-e", { manifest: agent.manifest });
    const theirs = await runs.run("mcp-f", { manifest: agent.manifest });
    const key = "turn-1:0:tool:e";
    await runs.journal("mcp-e", {
      effectId: key,
      toolName: "github__echo",
      input: {},
      mcp: { serverName: "github", serverToolName: "echo" },
    });
    const call = { server: { serverName: "github" }, effectId: key, name: "echo", arguments: {} };
    const running = send(held.server.url, TOOL_CALLS_PATH, mine.token, call, key);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    // Another session's re-send under the same key is not its journaled call: it never joins.
    const joined = await send(held.server.url, TOOL_CALLS_PATH, theirs.token, call, key);
    expect(joined.status).toBe(409);
    expect(await joined.json()).toMatchObject({ error: { code: "effect_not_journaled" } });
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

  /** `open`: the vault the gate opens for `tenantId`; the fixture's unless it returns another. */
  async function gate(options: { open?: (tenantId: string | undefined) => Promise<object | undefined> } = {}) {
    const authorizeMcp = vi.fn(async (_sessionId: string, request: { url: string }) => ({
      status: "authorized" as const,
      url: request.url,
      headers: { authorization: "Bearer vaulted" },
    }));
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: {
        open: async (tenantId?: string) =>
          ({
            tenantId: runs.tenantId,
            store: runs.store,
            session: (id: string) => runs.store.tx((t) => t.get("sessions", id)),
            authorizeMcp,
            ...(await options.open?.(tenantId)),
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

  it("calls the tool the token's session declares, with its vault credential and the token's turn", async () => {
    const target = await service();
    const { server, authorizeMcp } = await gate();
    const agent = billing(target.url);
    const grant = await runs.run("http-a", { manifest: agent.manifest });
    await runs.journal("http-a", {
      effectId: "turn-x:0:tool:1",
      toolName: "refund",
      input: { id: "A-1" },
    });
    const tools = httpToolGate({ url: server.url, token, runTokens: runs.grants });
    const outcome = await tools.callHttp!(
      {
        tool: { sessionId: "http-a", toolName: "refund" },
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
      tool: { ...(sessionId ? { sessionId } : {}), toolName },
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
    // A run's call needs its key, and its journal row (R5.6).
    const unkeyed = await send(mine.token, body(undefined, "nope"));
    expect(unkeyed.status).toBe(400);
    expect(await unkeyed.json()).toMatchObject({ error: { code: "key_required" } });
    expect(await (await send(token, body("http-b", "nope"))).json()).toEqual({
      ok: true,
      result: { kind: "failed", code: "http.undeclared", message: "'nope' is not an HTTP tool of the session" },
    });
    expect(target.seen).toEqual([]);
  });

  it("shuts down mid-call with a re-send whose caller went away, and leaves no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    cleanup.push(async () => void process.off("unhandledRejection", unhandled));
    // A service that never answers.
    let reached!: () => void;
    const called = new Promise<void>((resolve) => (reached = resolve));
    const silent: Server = createServer(() => reached());
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const agent = billing(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/refunds`);
    // Once the call runs, the re-send's journal check (the open naming the Tenant) waits until
    // its caller has gone, then reports when its read is done.
    let hold: { entered: () => void; released: Promise<void>; checked: () => void } | undefined;
    const { server } = await gate({
      open: async (tenantId) => {
        if (tenantId === undefined || !hold) return undefined;
        const { entered, released, checked } = hold;
        hold = undefined;
        entered();
        await released;
        return { store: { tx: (fn: never) => runs.store.tx(fn).finally(() => setImmediate(checked)) } };
      },
    });
    const responses: Promise<void>[] = [];
    server.server.on("request", (_req, res: ServerResponse) =>
      responses.push(new Promise<void>((resolve) => res.once("close", () => resolve()))),
    );
    await runs.run("http-d", { manifest: agent.manifest });
    const call = {
      tool: { sessionId: "http-d", toolName: "refund" },
      effectId: "turn-d:0:tool:1",
      turnId: "t",
      input: { id: "D-1" },
    };
    await runs.journal("http-d", { ...call.tool, effectId: call.effectId, input: call.input });
    const tools = httpToolGate({ url: server.url, token, runTokens: runs.grants });
    void tools.callHttp!(call, new AbortController().signal).catch(() => undefined);
    await called;

    let entered!: () => void;
    let release!: () => void;
    let checked!: () => void;
    const held = new Promise<void>((resolve) => (entered = resolve));
    const read = new Promise<void>((resolve) => (checked = resolve));
    hold = { entered, released: new Promise<void>((resolve) => (release = resolve)), checked };
    const gone = new AbortController();
    const resend = tools.callHttp!(call, gone.signal).catch(() => undefined);
    await held;
    gone.abort();
    await resend;
    await responses[1];
    // The re-send joins the running call with its own request already aborted.
    release();
    await read;
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).not.toHaveBeenCalled();
  });
});
