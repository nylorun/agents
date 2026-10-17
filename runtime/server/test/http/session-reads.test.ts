import { afterAll, beforeAll, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  HistoryPageSchema,
  ListSessionsResponseSchema,
  ModelCallExportPageSchema,
  ModelCallsPageSchema,
  SessionManifestViewSchema,
  SessionPageSchema,
  SessionUsageTotalsSchema,
} from "@nylorun/core/contracts";
import { AgentsClient } from "@nylorun/agents";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import { startTestTenant } from "../support/tenant.js";
import { testTenantPool } from "../support/store.js";
import { contextOf } from "../tenant/streams.suite.js";
import { manifestOf } from "../support/agents.js";

let rt: Awaited<ReturnType<typeof startTestTenant>>;
let client: AgentsClient;
async function request(path: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(rt.url + path, {
    method: body === undefined ? "GET" : "PUT",
    headers: { ...rt.headers(), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(path: string, extra?: Record<string, string>) {
  const response = await request(path, undefined, extra);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
const person = (name: string, scopes = "sessions:own agents:read agents:write") => ({
  "nylorun-subject": name,
  "nylorun-scopes": scopes,
});
beforeAll(async () => {
  rt = await startTestTenant();
  client = new AgentsClient({ url: rt.url, key: rt.applicationKey });
  const a = Agent({ id: "bot", name: "A" }).instructions("Manifest A").build();
  expect((await request("/v1/agent-manifests/bot", manifestOf(a))).status).toBe(200);
  expect((await request("/v1/agents/bot", { requestId: "a", manifest: "bot" })).status).toBe(200);
  for (const id of ["s-a", "s-b", "s-c", "s-d"])
    expect(
      (
        await request(`/v1/sessions/${id}`, {
          requestId: id,
          agent: "bot",
          ownerUserId: id === "s-d" ? "bob" : "ann",
        })
      ).status,
    ).toBe(200);
  await testTenantPool(
    rt.tenantId,
  )`update nylorun.sessions set created_at = case when id in ('s-a','s-b') then '2026-01-01T00:00:00.000123Z'::timestamptz else null end`;
});
afterAll(async () => {
  await rt?.close();
});

it("keeps legacy summaries strict and pages ties and legacy nulls without omissions", async () => {
  expect(ListSessionsResponseSchema.safeParse(await json("/v1/sessions")).success).toBe(true);
  expect(ListSessionsResponseSchema.safeParse(await json("/v1/sessions?cursor=ignored")).success).toBe(true);
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page = SessionPageSchema.parse(
      await json(`/v1/sessions?limit=1${cursor ? `&cursor=${cursor}` : ""}`),
    );
    found.push(...page.sessions.map((s) => s.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual(["s-b", "s-a", "s-d", "s-c"]);
  const own = await client.as("ann", { scopes: ["sessions:own"] }).sessions.page();
  expect(own.sessions.map((s) => s.id)).toEqual(["s-b", "s-a", "s-c"]);
  expect(
    (await request("/v1/sessions?limit=1&ownerUserId=ann", undefined, person("ann"))).status,
  ).toBe(403);
  const first = await client.sessions.page({ limit: 1, agentId: "bot" });
  expect((await request(`/v1/sessions?limit=1&cursor=${first.nextCursor}`)).status).toBe(400);
  // Past the Tenant's pageItems, a page holds that many (B15c).
  expect((await request("/v1/sessions?limit=201")).status).toBe(200);
  expect((await request("/v1/sessions?limit=1&cursor=broken")).status).toBe(400);
  expect(
    (await client.sessions.page({ status: "idle", ownerUserId: "bob" })).sessions.map((s) => s.id),
  ).toEqual(["s-d"]);
});

it("pins manifest A after saving B and exposes no session internals", async () => {
  const a = SessionManifestViewSchema.parse(await json("/v1/sessions/s-a/manifest"));
  const b = Agent({ id: "bot", name: "B" }).instructions("Manifest B").build();
  expect((await request("/v1/agent-manifests/bot", manifestOf(b))).status).toBe(200);
  expect(await client.session("s-a").manifest()).toEqual(a);
  expect(a).toMatchObject({ sessionId: "s-a", agentId: "bot", definition: { name: "bot", version: 1 } });
  expect(a.manifest.instructions).toEqual(["Manifest A"]);
  expect(JSON.stringify(a)).not.toMatch(/checkpoint|credential/);
  expect((await request("/v1/sessions/s-a/manifest", undefined, person("bob"))).status).toBe(404);
  // Spend is the application's: no subject scope reaches usage or calls (protocol 8).
  for (const suffix of ["usage", "calls/model"])
    expect((await request(`/v1/sessions/s-a/${suffix}`, undefined, person("ann"))).status).toBe(
      403,
    );
});

it("reconciles all billed rows including duplicates, genuine zero and unknown quality", async () => {
  const store = contextOf(rt.handle).store;
  for (const [id, turnId, tokensReported, costKnown, costUsd] of [
    ["call-a", "t1", true, true, 0.25],
    ["call-b", "t1", true, true, 0.25],
    ["call-c", "t2", false, false, 0],
    ["call-d", "t2", null, null, 0],
  ] as const)
    await store.tx((t) =>
      t.recordModelUsage({
        id,
        effectKey: id === "call-b" ? "call-a" : id,
        sessionId: "s-a",
        turnId,
        manifestName: "bot",
        provider: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd,
        tokensReported,
        costKnown,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  const totals = SessionUsageTotalsSchema.parse(await client.session("s-a").usage());
  expect(totals).toMatchObject({
    calls: 4,
    duplicates: 1,
    costUsd: 0.5,
    unpricedCalls: 1,
    unreportedCalls: 1,
    unknownQualityCalls: 1,
  });
  expect(await client.session("s-a").usage({ turnId: "t1" })).toMatchObject({
    calls: 2,
    costUsd: 0.5,
  });
  // Rows from before the split and the gate's timing: they count in the totals only.
  expect(totals).toMatchObject({
    costSplit: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    splitCalls: 0,
    modelTimeMs: 0,
    timedCalls: 0,
  });
  const first = ModelCallsPageSchema.parse(await client.session("s-a").modelCalls({ limit: 2 }));
  const second = await client.session("s-a").modelCalls({ limit: 2, cursor: first.nextCursor! });
  expect([...first.calls, ...second.calls].map((c) => c.id)).toEqual([
    "call-a",
    "call-b",
    "call-c",
    "call-d",
  ]);
  expect(JSON.stringify(first)).not.toMatch(/effectKey|txid/);
  // The Tenant's export is the Management API's: a management key, never an application key.
  // It serves rows below the cluster's snapshot horizon, which a transaction another test file
  // holds open may delay: drain until the rows are past it.
  const drain = async () => {
    const exported: string[] = [];
    let after: string | null = null;
    for (let caughtUp = false; !caughtUp; ) {
      const page = ModelCallExportPageSchema.parse(
        await json(
          `/v1/tenant/calls/model?limit=1${after === null ? "" : `&after=${after}`}`,
          rt.managementHeaders(),
        ),
      );
      exported.push(...page.calls.map((c) => c.id));
      ({ next: after, caughtUp } = page);
    }
    return exported;
  };
  await expect.poll(drain, { timeout: 10_000 }).toEqual(["call-a", "call-b", "call-c", "call-d"]);
  const appKey = await request("/v1/tenant/calls/model");
  expect(appKey.status).toBe(403);
  expect((await appKey.json()).code).toBe("key_role_mismatch");
  expect((await request("/v1/tenant/calls/model", undefined, person("ann"))).status).toBe(403);
  expect((await request(`/v1/sessions/s-b/calls/model?cursor=${first.nextCursor}`)).status).toBe(
    400,
  );
  expect((await request("/v1/sessions/missing/usage")).status).toBe(404);
});

it("splits cost by token kind and adds up model time, over the calls that kept them", async () => {
  const store = contextOf(rt.handle).store;
  const row = (id: string, extra: object) => ({
    id,
    effectKey: id,
    sessionId: "s-c",
    turnId: "t1",
    manifestName: "bot",
    provider: "openai",
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 1110,
    cachedTokens: 1000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.003,
    createdAt: "2026-01-01T00:00:02.000Z",
    ...extra,
  });
  await store.tx(async (t) => {
    await t.recordModelUsage(
      row("split-a", {
        startedAt: "2026-01-01T00:00:00.500Z",
        endedAt: "2026-01-01T00:00:02.000Z",
        costInputUsd: 0.001,
        costCacheReadUsd: 0.0005,
        costCacheWriteUsd: 0,
        costOutputUsd: 0.0015,
      }),
    );
    await t.recordModelUsage(
      row("split-b", {
        createdAt: "2026-01-01T00:00:05.000Z",
        startedAt: "2026-01-01T00:00:02.750Z",
        endedAt: "2026-01-01T00:00:05.000Z",
      }),
    );
  });
  const totals = SessionUsageTotalsSchema.parse(await client.session("s-c").usage());
  expect(totals).toMatchObject({
    calls: 2,
    costUsd: 0.006,
    costSplit: { input: 0.001, cacheRead: 0.0005, cacheWrite: 0, output: 0.0015 },
    splitCalls: 1,
    modelTimeMs: 3750,
    timedCalls: 2,
  });
  const { calls } = ModelCallsPageSchema.parse(await client.session("s-c").modelCalls());
  expect(calls.map((c) => [c.id, c.startedAt, c.endedAt, c.usage?.costSplit])).toEqual([
    [
      "split-a",
      "2026-01-01T00:00:00.500Z",
      "2026-01-01T00:00:02.000Z",
      { input: 0.001, cacheRead: 0.0005, cacheWrite: 0, output: 0.0015 },
    ],
    ["split-b", "2026-01-01T00:00:02.750Z", "2026-01-01T00:00:05.000Z", null],
  ]);
  // A protocol 17 client parses these reads strictly: it gets them as they were.
  const before = { [PROTOCOL_HEADER]: "17" };
  const oldTotals = await json("/v1/sessions/s-c/usage", before);
  expect(oldTotals).toMatchObject({ calls: 2, costUsd: 0.006 });
  for (const key of ["costSplit", "splitCalls", "modelTimeMs", "timedCalls"])
    expect(oldTotals).not.toHaveProperty(key);
  const oldCalls = (await json("/v1/sessions/s-c/calls/model", before)).calls;
  expect(oldCalls).toHaveLength(2);
  for (const call of oldCalls) {
    expect(call).not.toHaveProperty("startedAt");
    expect(call).not.toHaveProperty("endedAt");
    expect(call.usage).not.toHaveProperty("costSplit");
    expect(call.usage).toMatchObject({ costUsd: 0.003, duplicate: false });
  }
});

it("advances bounded history over internal events and reapplies ownership and filter binding", async () => {
  const ctx = contextOf(rt.handle);
  await ctx.store.tx(async (t) => {
    await t.event("s-a", null, "transcript.updated", { keep: 0, entries: [], length: 0 });
    await t.event("s-a", null, "turn.completed", { output: {} });
  });
  // `agent.attached`, recorded when the session opened on its Agent (protocol 16), and the turn.
  await expect.poll(async () => (await json("/v1/sessions/s-a/items")).items.length).toBe(2);
  const legacy = await json("/v1/sessions/s-a/items");
  expect(Object.keys(legacy).sort()).toEqual(["cursor", "items"]);
  let cursor: string | undefined;
  const seen: string[] = [];
  let empty = false;
  for (let n = 0; n < 20; n++) {
    const page = HistoryPageSchema.parse(await client.session("s-a").history({ limit: 1, cursor }));
    seen.push(...page.items.map((e) => e.cursor));
    empty ||= page.items.length === 0;
    cursor = page.cursor ?? undefined;
    if (page.tail) break;
  }
  expect(seen).toEqual(legacy.items.map((e: { cursor: string }) => e.cursor));
  expect(empty).toBe(true);
  expect(
    (await request(`/v1/sessions/s-a/items?limit=1&cursor=${cursor}&agent=other`)).status,
  ).toBe(400);
  expect(
    (await request(`/v1/sessions/s-a/items?limit=1&cursor=${cursor}`, undefined, person("bob")))
      .status,
  ).toBe(404);
  const abort = new AbortController();
  const live = await fetch(`${rt.url}/v1/sessions/s-a/events?cursor=${cursor}`, {
    headers: rt.headers(),
    signal: abort.signal,
  });
  expect(live.status).toBe(200);
  const reader = live.body!.getReader();
  await ctx.store.tx((t) => t.event("s-a", null, "turn.completed", { output: {} }));
  const chunk = new TextDecoder().decode((await reader.read()).value);
  expect(chunk).toContain("turn.completed");
  abort.abort();
  await reader.cancel().catch(() => {});
});
