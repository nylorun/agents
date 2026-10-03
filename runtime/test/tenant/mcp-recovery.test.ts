/**
 * F4.1 G3: a remote MCP call that outlives the process that sent it. Through the Tool Gate
 * (`NYLORUN_TEST_MODEL_GATE=http`: a gates service on 127.0.0.1 in this process), the call
 * keeps running at the gate when its owner dies or shuts down; the next advance re-sends it
 * from the journal and joins it, so the turn completes with one call to the MCP server and
 * nothing `uncertain`. A user cancel still stops the call at the gate, which sends the server
 * MCP's `notifications/cancelled`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import { openTestSessionStore } from "../support/store.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { TenantWorkers, type TenantExecution } from "../../src/tenant/worker.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "mcp-recovery-token-aaaaaaaaaaaaaaa";
const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** A remote MCP server whose `slow` tool holds every call until `release()`. */
async function heldServer() {
  let calls = 0;
  let aborted = 0;
  const methods: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as { method?: string }) : undefined;
    if (body?.method) methods.push(body.method);
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: "remote", version: "0.0.0" });
    mcp.registerTool(
      "slow",
      { description: "Holds until released.", inputSchema: { value: z.number() } },
      async ({ value }) => {
        calls += 1;
        entered();
        let finished = false;
        res.on("close", () => {
          if (!finished) aborted += 1;
        });
        await released;
        finished = true;
        return { content: [{ type: "text", text: `done ${value}` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    started,
    release: () => release(),
    calls: () => calls,
    aborted: () => aborted,
    /** The JSON-RPC methods the server received, notifications included. */
    methods: () => [...methods],
  };
}

/** Calls `remote__slow` once, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const call = effect.input as { prompt?: { kind?: string }[] };
  if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "remote__slow", args: { value: 7 } }] };
};

function hostExecution(): TenantExecution & { execution: MemoryExecution } {
  return { execution: new MemoryExecution(), workers: new TenantWorkers() };
}

async function boot(url: string): Promise<Started> {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: model,
    execution: hostExecution(), // never started: only the test advances
    workerId: "worker-a",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  open.push(() => runtime.close());
  const agent = Agent({ id: "bot", name: "Bot" })
    .mcp({ remote: { type: "streamable-http", url } })
    .build();
  for (const [path, body] of [
    ["/v1/agents/bot", { requestId: "put-1", manifest: agent.manifest, implementationVersion: "dev" }],
    ["/v1/sessions/s1", { requestId: "session-s1", agentId: "bot", ownerUserId: "u" }],
  ] as const) {
    const response = await fetch(`${runtime.url}${path}`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  }
  return runtime;
}

const command = (runtime: Started, body: Record<string, unknown>) =>
  fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify(body),
  });

const message = (runtime: Started) =>
  command(runtime, { type: "message", requestId: "m1", idempotencyKey: "m1", content: "hello" });

async function view(runtime: Started) {
  return (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers: server })).json()) as {
    status: string;
  };
}

async function types(runtime: Started) {
  const body = (await (
    await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: server })
  ).json()) as { items: { type: string }[] };
  return body.items.map((item) => item.type);
}

const workerOf = (runtime: Started) => (runtime.handle as TenantRuntime).worker;

/** Advances until the session leaves `busy` (another advance's lease is ending). */
async function settle(runtime: Started) {
  const worker = workerOf(runtime);
  let result = await worker.advance("s1", new AbortController().signal);
  for (let attempt = 0; result.status === "busy" && attempt < 50; attempt += 1)
    result = await worker.advance("s1", new AbortController().signal);
  return result;
}

it("finishes a turn whose owner died mid MCP call: the next advance re-sends the call and joins it", async () => {
  const remote = await heldServer();
  const runtime = await boot(remote.url);
  expect((await message(runtime)).ok).toBe(true);
  const worker = workerOf(runtime);
  const stale = worker.advance("s1", new AbortController().signal);
  await remote.started; // the MCP effect is `invoking` under worker-a, and held at the gate
  const staleToken = runtime.gate!.runGrants.token("s1")!;
  expect(staleToken).toBeDefined();

  // Another Worker took the session over and died too: its lease already expired.
  const other = await openTestSessionStore(runtime);
  try {
    const taken = await other.tx((t) =>
      t.takeOwnership("s1", {
        owner: "worker-dead",
        now: new Date(Date.now() + 120_000),
        leaseMs: -240_000,
      }),
    );
    expect(taken).toMatchObject({ status: "owned", takeover: true });
  } finally {
    await other.close();
  }

  const next = worker.advance("s1", new AbortController().signal);
  await vi.waitFor(async () => expect((await view(runtime)).status).toBe("running"));
  // The new owner's run token replaced the old owner's, which is stale at the gate (F5, G4).
  await vi.waitFor(() => expect(runtime.gate!.runGrants.token("s1")).not.toBe(staleToken));
  const refused = await fetch(`${runtime.gate!.url}/nylorun/v1/tool-calls`, {
    method: "POST",
    headers: { authorization: `Bearer ${staleToken}`, "content-type": "application/json" },
    body: JSON.stringify({ server: { capabilityId: "c", serverName: "s" }, effectId: "late", name: "slow", arguments: {} }),
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "run_stale" } });
  remote.release();
  expect(await next).toEqual({ status: "done" });
  await stale;

  expect((await view(runtime)).status).toBe("completed");
  const events = await types(runtime);
  expect(events).not.toContain("effect.uncertain");
  expect(events.filter((type) => type === "tool.completed")).toHaveLength(1);
  expect(remote.calls()).toBe(1);
});

it("finishes a turn whose Worker shut down mid MCP call, with one call to the server", async () => {
  const remote = await heldServer();
  const runtime = await boot(remote.url);
  expect((await message(runtime)).ok).toBe(true);
  const stopping = new AbortController();
  const first = workerOf(runtime).advance("s1", stopping.signal);
  await remote.started;
  stopping.abort(new Error("The Worker is stopping")); // a shutdown, not a cancel
  await first;
  expect(await types(runtime)).not.toContain("effect.uncertain");

  const next = settle(runtime);
  remote.release();
  expect(await next).toEqual({ status: "done" });
  expect((await view(runtime)).status).toBe("completed");
  expect(await types(runtime)).not.toContain("effect.uncertain");
  expect(remote.calls()).toBe(1);
  expect(remote.aborted()).toBe(0);
});

it("stops the MCP call at the gate when the user cancels mid-call", async () => {
  const remote = await heldServer();
  const runtime = await boot(remote.url);
  expect((await message(runtime)).ok).toBe(true);
  const running = workerOf(runtime).advance("s1", new AbortController().signal);
  await remote.started;
  expect((await command(runtime, { type: "cancel", requestId: "c1", idempotencyKey: "c1" })).ok).toBe(true);
  await vi.waitFor(() => expect(remote.methods()).toContain("notifications/cancelled"));
  await running;
  expect((await view(runtime)).status).toBe("cancelled");
  expect(remote.calls()).toBe(1);
  remote.release();
});
