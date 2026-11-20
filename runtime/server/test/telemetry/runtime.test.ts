/**
 * A Runtime's live telemetry (ADR-159), read in memory: every API request makes one
 * `http.server.request.duration` point labelled with its declared route and `nylorun.client`; a
 * turn makes its model call's points, its `gen_ai.invoke_agent.duration` and, queued, its
 * `nylorun.queue.wait`. With span export a request makes one server span, which parents the turn
 * it starts and stamps the log lines written while it runs; without it, a turn joins the caller's
 * trace exactly as before.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { Agent } from "@nylorun/agents";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { testPool } from "../support/store.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { createHostLogger } from "../../src/host/logger.js";
import { deploy } from "../support/agents.js";
import { startTestTenant } from "../support/tenant.js";
import { countOf, startTestTelemetry, type TestTelemetry } from "../support/telemetry.js";

const APP = "telemetry-runtime-token-aaaaaaaaaaaaaaaa";
const headers = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
  // Protocol 17 queues a message sent while a turn runs.
  "nylorun-protocol": String(PROTOCOL_VERSION),
};
const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** A Runtime behind the Host app (`createHost`), as `host/main.ts` serves it, on the fixture model. */
async function boot(test: TestTelemetry) {
  const lines: Record<string, unknown>[] = [];
  const root = await mkdtemp(join(tmpdir(), "nylorun-telemetry-"));
  const runtime = await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    applicationKey: APP,
    model: { kind: "fixture" },
    logger: createHostLogger((line) => lines.push(JSON.parse(line) as Record<string, unknown>)),
  });
  open.push(() => rm(root, { recursive: true, force: true }));
  open.push(() => runtime.close());
  open.push(() => test.close());
  return setUp(runtime, lines);
}

/** A Tenant served without the Host app, whose model `model` answers. */
async function bootTenant(test: TestTelemetry, model: ModelProvider) {
  const runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  open.push(() => runtime.close());
  open.push(() => test.close());
  return setUp(runtime, []);
}

async function setUp<R extends { url: string }>(runtime: R, lines: Record<string, unknown>[]) {
  await deploy(runtime.url, headers, Agent({ id: "bot", name: "Bot" }).build().manifest, { id: "bot" });
  const put = await fetch(`${runtime.url}/v1/sessions/s1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ requestId: "s1", agent: "bot", ownerUserId: "u" }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  return { runtime, lines };
}

/** Sends a message; each its own (the tests share one database, so one Tenant and session). */
async function say(url: string, extra: Record<string, string> = {}, id = randomUUID()): Promise<Response> {
  const response = await fetch(`${url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ type: "message", requestId: id, idempotencyKey: id, content: "go" }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}

async function settled(url: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { status } = (await (await fetch(`${url}/v1/sessions/s1`, { headers })).json()) as { status: string };
    if (["completed", "failed", "cancelled"].includes(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The turn did not settle");
}

async function items(url: string) {
  const body = (await (await fetch(`${url}/v1/sessions/s1/items`, { headers })).json()) as {
    items: { type: string; payload: Record<string, any> }[];
  };
  return body.items;
}

describe("a Runtime's telemetry", { timeout: 60_000 }, () => {
  it("makes one duration point per request, by declared route and client, never by path", async () => {
    const test = startTestTelemetry();
    const { runtime } = await boot(test);
    await say(runtime.url, { "nylorun-client": "Studio" });
    await fetch(`${runtime.url}/health`, { headers: { "nylorun-client": "cli" } });
    await fetch(`${runtime.url}/v1/no-such-route/abc`, { headers: { ...headers, "nylorun-client": "curl" } });
    await fetch(`${runtime.url}/v1/a2a/agents/bot/card`, { headers: { ...headers, "nylorun-client": "sdk" } });
    await settled(runtime.url);

    const points = await test.points("http.server.request.duration");
    const command = points.filter((point) => point.attributes["http.route"] === "/v1/sessions/{sessionId}/commands");
    expect(command).toHaveLength(1);
    expect(command[0]!.attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/v1/sessions/{sessionId}/commands",
      "http.response.status_code": 200,
      "nylorun.client": "studio",
    });
    expect(countOf(command[0])).toBe(1);
    expect(points.find((point) => point.attributes["http.route"] === "/health")?.attributes["nylorun.client"]).toBe("cli");
    expect(points.find((point) => point.attributes["http.route"] === "other")?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "nylorun.client": "other",
    });
    // A2A is labelled by its route, whatever the header says.
    expect(
      points.find((point) => point.attributes["http.route"] === "/v1/a2a/agents/{agentId}/card")?.attributes["nylorun.client"],
    ).toBe("a2a");
    // No attribute holds a session id or a raw path.
    expect(JSON.stringify(points.map((point) => point.attributes))).not.toMatch(/"s1"|\/sessions\/s1|abc/);
    // Without span export there is no span, and the turn joins the caller's trace as before.
    expect(test.spans()).toEqual([]);
  });

  it("measures the turn and its model call once each", async () => {
    const test = startTestTelemetry();
    const { runtime } = await boot(test);
    await say(runtime.url);
    await settled(runtime.url);
    const turns = await test.points("gen_ai.invoke_agent.duration");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.attributes).toMatchObject({ "gen_ai.operation.name": "invoke_agent" });
    expect(turns[0]!.attributes["error.type"]).toBeUndefined();
    expect(countOf(turns[0])).toBe(1);
    const calls = await test.points("gen_ai.client.inference.duration");
    expect(calls.reduce((sum, point) => sum + countOf(point), 0)).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.attributes).toMatchObject({ "gen_ai.operation.name": "chat" });
    expect(calls.every((point) => point.attributes["error.type"] === undefined)).toBe(true);
  });

  it("measures how long a queued message waited until a turn took it", async () => {
    const test = startTestTelemetry();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const { runtime } = await bootTenant(test, async () => {
      calls += 1;
      if (calls === 1) await held;
      return { output: [{ type: "text", text: "done" }] };
    });
    await say(runtime.url);
    const queued = (await (await say(runtime.url)).json()) as { status?: string; queuedMessageId?: string };
    expect(JSON.stringify(queued)).toContain("queued");
    release();
    await expect
      .poll(async () => (await test.points("nylorun.queue.wait")).map((point) => [point.attributes, countOf(point)]), {
        timeout: 20_000,
      })
      .toEqual([[{ "nylorun.queue.outcome": "taken" }, 1]]);
  });

  it("makes a server span with span export, parents the turn under it, and stamps its log lines", async () => {
    const test = startTestTelemetry({ spans: true });
    const { runtime, lines } = await boot(test);
    lines.length = 0;
    await say(runtime.url, { traceparent: INBOUND, tracestate: "vendor=1", "nylorun-client": "sdk" });
    await settled(runtime.url);
    const server = test.spans().filter((span) => span.kind === SpanKind.SERVER && span.name.startsWith("POST "));
    expect(server.map((span) => span.name)).toEqual(["POST /v1/sessions/{sessionId}/commands"]);
    const [span] = server;
    expect(span!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span!.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span!.attributes).toMatchObject({
      "http.request.method": "POST",
      "http.route": "/v1/sessions/{sessionId}/commands",
      "http.response.status_code": 200,
      "nylorun.client": "sdk",
    });
    // The turn is the server span's child, in the caller's trace, with the caller's tracestate.
    const message = (await items(runtime.url)).filter((item) => item.type === "command.message").at(-1)!;
    expect(message.payload.trace).toEqual({
      traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${span!.spanContext().spanId}-01`,
      tracestate: "vendor=1",
    });
    // The request's log line carries the span's ids.
    const request = lines.find((line) => line.message === "request" && line.method === "POST");
    expect(request).toMatchObject({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: span!.spanContext().spanId });
  });
});
