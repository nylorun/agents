/**
 * The trace route (R7.5): a turn's spans as OTLP JSON, built by the projector's own mapping, so
 * the route and the exporter give the same spans for the same turn.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ModelProvider } from "../../src/core/provider.js";
import type { ChangeSource } from "../../src/streams/relay/types.js";
import { effectSpanOf, turnSpanOf } from "../../src/traces/ids.js";
import { traceKey } from "../../src/traces/key.js";
import type { OtlpSpan } from "../../src/traces/map.js";
import { createTraceProjector } from "../../src/traces/projector.js";
import { openTestSessionStore, testTenantPool } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "r7-route-token-aaaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

async function hookService() {
  const traceparents: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    traceparents.push(req.headers.traceparent as string | undefined);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ secret: "tool-result-7f3a" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, traceparents };
}

const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (prompt.some((item) => item.kind === "tool-result")) return { output: [{ type: "text", text: "all done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "hook", args: { n: 1 } }] };
};

async function boot(content: ReadonlySet<"tool-results">) {
  const service = await hookService();
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: model,
    traces: { resource: { serviceName: "agents-test" }, content },
  });
  open.push(() => runtime.close());
  const manifest = Agent({ id: "bot", name: "Bot" })
    .tools(http({ name: "hook", input: z.object({ n: z.number() }), url: service.url }))
    .build().manifest;
  for (const [path, body] of [
    ["/v1/agents/bot", { requestId: "a", manifest, implementationVersion: "dev" }],
    ["/v1/sessions/s1", { requestId: "s", agentId: "bot", ownerUserId: "person-9c2e" }],
  ] as const) {
    const response = await fetch(`${runtime.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(response.ok, await response.clone().text()).toBe(true);
  }
  const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: "m", idempotencyKey: "idem-7c1d", content: "go" }),
  });
  const { turnId } = (await sent.json()) as { turnId: string };
  for (let attempt = 0; ; attempt += 1) {
    const { status } = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string };
    if (status === "completed") break;
    if (attempt > 600) throw new Error(`The turn did not complete: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { runtime, service, turnId };
}

const read = async (url: string, turnId: string, key = APP) =>
  fetch(`${url}/v1/sessions/s1/turns/${turnId}/trace`, { headers: { ...headers, authorization: `Bearer ${key}` } });

/** The spans the projector posts for the session's committed rows, in commit order. */
async function exported(tenantId: string, root: string, content: ReadonlySet<"tool-results">): Promise<OtlpSpan[]> {
  const sql = testTenantPool(tenantId);
  const rows = await sql<{ seq: string; body: unknown }[]>`
    SELECT seq, body FROM nylorun_streams.session_events WHERE session_id = 's1' ORDER BY seq`;
  const store = await openTestSessionStore({ root, tenantId });
  open.push(() => store.close());
  const posted: OtlpSpan[] = [];
  let handlers: Parameters<ChangeSource["start"]>[0] | undefined;
  const projector = createTraceProjector({
    contentBytes: async () => 8 * 1024,
    source: {
      start: (h) => void (handlers = h),
      acknowledge: () => {},
      reconciled: async () => {},
      stop: async () => {},
    },
    post: async (spans) => (posted.push(...spans), "posted"),
    key: () => traceKey(store),
    turnMessage: async () => undefined,
    content,
    maxDelayMs: 1,
  });
  projector.start();
  rows.forEach((row, at) =>
    handlers!.onTx({
      endLsn: `0/${at + 1}`,
      rows: [{ tenantId, sessionId: "s1", seq: Number(row.seq), generation: 0, body: typeof row.body === "string" ? JSON.parse(row.body) : row.body }],
    }),
  );
  await projector.idle();
  return posted;
}

describe("GET /v1/sessions/{id}/turns/{turnId}/trace", { timeout: 60_000 }, () => {
  it("answers the turn's spans, equal to the exporter's for the same turn", async () => {
    const { runtime, service, turnId } = await boot(new Set());
    const response = await read(runtime.url, turnId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceSpans: any[] };
    const [resource] = body.resourceSpans;
    expect(resource.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "agents-test" } });
    const spans = resource.scopeSpans[0].spans as OtlpSpan[];
    expect(spans.map((span) => span.name)).toEqual(["chat", "execute_tool hook", "chat", "invoke_agent bot"]);
    const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
    const key = await traceKey(store).finally(() => store.close());
    const root = spans.at(-1)!;
    expect(root.spanId).toBe(turnSpanOf(key, turnId));
    for (const span of spans.slice(0, -1)) {
      expect(span.traceId).toBe(root.traceId);
      expect(span.parentSpanId).toBe(root.spanId);
    }
    // The tool saw its own span as its parent.
    const tool = spans[1]!;
    const effectId = tool.attributes.find((a) => a.key === "nylorun.effect.id")!.value.stringValue!;
    expect(tool.spanId).toBe(effectSpanOf(key, effectId));
    expect(service.traceparents).toEqual([`00-${root.traceId}-${tool.spanId}-01`]);
    // References only: no content, no person, no key.
    const text = JSON.stringify(body);
    for (const value of ["tool-result-7f3a", "all done", "person-9c2e", "idem-7c1d", APP]) expect(text).not.toContain(value);
    // The exporter's spans for the turn are the route's.
    const posted = (await exported(runtime.tenantId, runtime.root, new Set())).filter((span) => span.traceId === root.traceId);
    expect(JSON.stringify(posted)).toBe(JSON.stringify(spans));
    // Twice the same.
    expect(await (await read(runtime.url, turnId)).text()).toBe(JSON.stringify(body));
  });

  it("carries the content the installation opted into", async () => {
    const { runtime, turnId } = await boot(new Set(["tool-results"]));
    const text = await (await read(runtime.url, turnId)).text();
    expect(text).toContain("tool-result-7f3a");
    expect(text).not.toContain("all done");
  });

  it("answers no spans for a turn the session never had, and 404 for another's session", async () => {
    const { runtime } = await boot(new Set());
    const none = (await (await read(runtime.url, "trn_none")).json()) as { resourceSpans: any[] };
    expect(none.resourceSpans[0].scopeSpans[0].spans).toEqual([]);
    expect((await fetch(`${runtime.url}/v1/sessions/nope/turns/t/trace`, { headers })).status).toBe(404);
  });
});
