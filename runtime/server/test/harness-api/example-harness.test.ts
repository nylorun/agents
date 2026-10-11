/**
 * The example harness (`examples/harness-minimal`, R4.8), written only against
 * `@nylorun/core/harness-api`, runs turns on a real Runtime beside ours: it connects over the
 * Harness API's WebSocket with its own per-harness token and says `hello` as `minimal`, and our
 * harness (a harness service over a loopback WebSocket) stays connected. Sessions on an
 * Environment whose harness is `minimal` run on the example, the others on ours (R4.1). Its model
 * calls go through the Model Gate on the fixture model, metered there, and its bash calls are
 * journaled like ours.
 */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startHarnessListener } from "../../src/harness-api/ws-server.js";
import { putHarnessToken } from "../../src/tenant/harness-tokens.js";
import type { SessionStore } from "../../src/store/types.js";
import { connect, serve } from "../../../../examples/harness-minimal/src/harness.js";
import { boot, server, until, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/**
 * A Runtime with a gates service on 127.0.0.1, its fixture model on, our harness connected over a
 * loopback WebSocket, and the example connected with its own token as `minimal`.
 */
async function start(): Promise<Started> {
  // The gates service, and the run tokens the gate requires.
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
  const runtime = await boot({ harness: "ws" });
  cleanups.push(() => runtime.close());
  const store = (runtime.handle as unknown as { ctx: { store: SessionStore } }).ctx.store;
  // What `nylorun-operate harness token put minimal` does.
  const put = (await putHarnessToken(store, "minimal")) as { token: string };
  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    attach: async () => (channel, peer) => runtime.handle.attachHarness!(channel, peer),
    harnessOfToken: (bearer) => runtime.handle.harnessOfToken!(bearer),
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => listener.close());
  const seeded = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
  });
  expect(seeded.status).toBe(200);

  const channel = await connect(listener.url, put.token);
  const stopping = new AbortController();
  const served = serve(channel, { name: "minimal", gatesUrl: runtime.gate!.url, signal: stopping.signal });
  cleanups.push(async () => {
    stopping.abort();
    channel.close("test over");
    await served.catch(() => undefined);
  });
  return runtime;
}

async function api(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

type Item = { type: string; payload: any; source?: { kind: string; id?: string }; evidence?: string };

/** Sends `content` and waits for the turn's end. */
async function say(runtime: Started, session: string, content: string, n: number): Promise<Item[]> {
  await api(runtime, "POST", `/v1/sessions/${session}/commands`, {
    type: "message",
    requestId: `m-${session}-${n}`,
    idempotencyKey: `m-${session}-${n}`,
    content,
  });
  return until(
    async () => (await api(runtime, "GET", `/v1/sessions/${session}/items`)).body.items as Item[],
    (list) => list.filter((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type)).length >= n,
    `turn ${n} of ${session}`,
    30_000
  );
}

const agent = Agent({ id: "bot", name: "Bot" }).instructions("Answer briefly.").build();

async function setUp(runtime: Started) {
  expect(
    (await api(runtime, "PUT", "/v1/agents/bot", { requestId: "a", manifest: agent.manifest, implementationVersion: "dev" }))
      .status
  ).toBe(200);
  expect((await api(runtime, "PUT", "/v1/environments/text", { kind: "none", harness: "minimal" })).status).toBe(200);
  expect((await api(runtime, "PUT", "/v1/environments/box", { kind: "virtual", harness: "minimal" })).status).toBe(200);
}

const open = async (runtime: Started, id: string, environment?: string) =>
  expect(
    (
      await api(runtime, "PUT", `/v1/sessions/${id}`, {
        requestId: `s-${id}`,
        agentId: "bot",
        ownerUserId: "u",
        ...(environment ? { environment } : {}),
      })
    ).status
  ).toBe(200);

it("completes fixture turns on the example beside ours, each harness serving its own sessions", async () => {
  const runtime = await start();
  await setUp(runtime);
  await open(runtime, "s1", "text");
  await open(runtime, "ours");
  expect((await api(runtime, "GET", "/v1/sessions/s1")).body.harness).toBe("minimal");
  expect((await api(runtime, "GET", "/v1/sessions/ours")).body.harness).toBe("nylorun");

  const first = await say(runtime, "s1", "conformance:text", 1);
  expect(first.find((item) => item.type === "turn.completed")?.payload).toEqual({ output: "conformance ok" });
  const assistant = first.find((item) => item.type === "message.assistant");
  expect(assistant?.payload).toMatchObject({ text: "conformance ok" });
  // The example wrote it: the log says so (R4.9).
  expect(assistant).toMatchObject({ source: { kind: "harness", id: "minimal" }, evidence: "claimed" });
  const calls = (await api(runtime, "GET", "/v1/sessions/s1/calls/model")).body.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ provider: "fixture", usage: { costUsd: 0 } });

  // Our harness serves the session pinned to it, at the same time.
  const ours = await say(runtime, "ours", "conformance:text", 1);
  expect(ours.find((item) => item.type === "message.assistant")).toMatchObject({
    payload: { text: "conformance ok" },
    source: { kind: "harness", id: "nylorun" },
  });

  // A second turn reads the first one back from the transcript: its prompt is longer.
  const second = await say(runtime, "s1", "conformance:text", 2);
  expect(second.filter((item) => item.type === "turn.completed")).toHaveLength(2);
  const both = (await api(runtime, "GET", "/v1/sessions/s1/calls/model")).body.calls as {
    usage: { inputTokens: number };
  }[];
  expect(both).toHaveLength(2);
  const [shorter, longer] = both.map((call) => call.usage.inputTokens).sort((a, b) => a - b);
  expect(longer).toBeGreaterThan(shorter! + 5);
  expect((await api(runtime, "GET", "/v1/sessions/s1")).body.status).toBe("completed");
}, 90_000);

it("runs bash for a session on a virtual Environment, journaled and reported like ours", async () => {
  const runtime = await start();
  await setUp(runtime);
  await open(runtime, "s2", "box");

  const items = await say(runtime, "s2", 'conformance:tool bash {"command":"echo hi"}', 1);
  expect(items.find((item) => item.type === "tool.completed")).toMatchObject({
    payload: { toolName: "bash", output: { exitCode: 0, stdout: "hi\n" } },
    source: { kind: "harness", id: "minimal" },
  });
  const done = items.find((item) => item.type === "turn.completed");
  expect(done?.payload.output).toMatch(/^conformance tool completed: .*hi/);
  const calls = (await api(runtime, "GET", "/v1/sessions/s2/calls/model")).body.calls;
  expect(calls.map((call: { provider: string }) => call.provider)).toEqual(["fixture", "fixture"]);
}, 90_000);
