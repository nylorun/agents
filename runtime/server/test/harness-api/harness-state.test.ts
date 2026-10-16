/**
 * Harness-owned state (R4.2): a custom harness's turn state is stored as it sent it, capped, and
 * handed back only to it; it cannot pause for approvals; and a tool it runs itself is journaled
 * like ours, as a `harness` call (protocol 15: the call names its target), so the log records
 * what really ran.
 */
import { afterEach, expect, it } from "vitest";
import { HARNESS_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { HARNESS_API_VERSION, effectRequestHash, type EffectIntent, type TurnStart } from "@nylorun/core/harness-api";
import { boot, plain, server, until, type Started } from "../host/execution-support.js";
import { attachHost, deployCustom, pods } from "../support/custom-harness.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function call(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

/**
 * A Runtime with only a custom harness, `acme-mini`, connected as the host of pod Agent env-acme
 * (a custom harness runs from its pod's image), and session s1 on that Agent.
 */
async function start() {
  const runtime = await boot({ harness: "remote", pods: pods() });
  cleanups.push(() => runtime.close());
  await deployCustom(runtime.url, server, plain, { id: "env-acme", harness: "acme-mini" });
  const acme = attachHost(runtime, "env-acme", cleanups);
  await acme.request("hello", { api: HARNESS_API_VERSION, name: "acme-mini", version: "0", features: {} });
  expect((await call(runtime, "PUT", "/v1/sessions/s1", { requestId: "s1", agent: "env-acme", ownerUserId: "u" })).status).toBe(
    200
  );
  return { runtime, acme };
}

async function message(runtime: Started, n: number) {
  const sent = await call(runtime, "POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: `m${n}`,
    idempotencyKey: `m${n}`,
    content: `turn ${n}`,
  });
  expect(sent.status).toBeLessThan(300);
}

const view = async (runtime: Started) => (await call(runtime, "GET", "/v1/sessions/s1")).body;

it("stores a custom harness's state as sent, and hands it back on the next turn", async () => {
  const { runtime, acme } = await start();
  // Fields our engine's state has: core must not read, rebase or strip them for another harness.
  const state = { steps: 1, transcript: ["mine"], manifestHash: "not-a-hash", nested: { a: [1, 2] } };
  const first = acme.request("lease", {});
  await message(runtime, 1);
  const { run } = await first;
  await acme.request("turn.completed", { runId: run.runId, status: "completed", state, output: "one" });
  await until(() => view(runtime), (v) => v.status === "completed", "first turn");

  const second = acme.request("lease", {});
  await message(runtime, 2);
  const { input } = (await second) as { input: TurnStart };
  expect((input.checkpoint as { state?: unknown }).state).toEqual(state);
});

it("fails the turn when a custom harness's state is over 256 KiB", async () => {
  const { runtime, acme } = await start();
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run } = await leased;
  await expect(
    acme.request("turn.completed", { runId: run.runId, status: "completed", state: { blob: "x".repeat(257 * 1024) } })
  ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("harnessStateBytes (262144 bytes") });
  await until(() => view(runtime), (v) => v.status === "failed" || v.status === "idle", "failed turn");
});

/** Sets the Tenant's Runtime limits (`PUT /v1/tenant/limits`). */
async function putLimits(runtime: Started, limits: Record<string, number>) {
  const response = await fetch(`${runtime.url}/v1/tenant/limits`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ limits }),
  });
  expect(response.status).toBe(200);
}

it("hands the harness the Tenant's Runtime limits in turn.start, and holds its state to a lowered one", async () => {
  const { runtime, acme } = await start();
  await putLimits(runtime, { harnessStateBytes: 1024 });
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run, input } = (await leased) as { run: { runId: string }; input: TurnStart };
  // Only the limits a harness must respect (B15).
  expect(input.limits).toEqual({ ...HARNESS_LIMIT_DEFAULTS, harnessStateBytes: 1024 });
  await expect(
    acme.request("turn.completed", { runId: run.runId, status: "completed", state: { blob: "x".repeat(2048) } })
  ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("harnessStateBytes (1024 bytes") });
  await until(() => view(runtime), (v) => v.status === "failed" || v.status === "idle", "failed turn");
});

it("refuses an effect outcome past the record entry limit, and records nothing of it", async () => {
  const { runtime, acme } = await start();
  await putLimits(runtime, { recordEntryBytes: 4096 });
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run, input } = (await leased) as {
    run: { runId: string; sessionId: string; turnId: string };
    input: TurnStart;
  };
  expect(input.limits.recordEntryBytes).toBe(4096);
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const effect: EffectIntent = {
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:1:c1`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    toolName: "apply_patch",
    target: { kind: "harness" },
    input: {},
    context: { callId: "c1", invocationId: "i1" },
  };
  await acme.request("effect.intent", { runId: run.runId, effect, requestHash: effectRequestHash(effect) });
  await expect(
    acme.request("effect.outcome", {
      runId: run.runId,
      effectId: effect.effectId,
      value: { kind: "completed", output: "x".repeat(8 * 1024) },
    })
  ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("recordEntryBytes (4096 bytes") });
  // Core shapes nothing (protocol 15): an MCP tool's outcome past the limit is refused alike.
  await expect(
    acme.request("effect.outcome", {
      runId: run.runId,
      effectId: effect.effectId,
      value: { kind: "completed", output: [{ type: "text", text: "x".repeat(8 * 1024) }] },
    })
  ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("artifact.write") });
  // What fits is recorded as before.
  await acme.request("effect.outcome", {
    runId: run.runId,
    effectId: effect.effectId,
    value: { kind: "completed", output: "ok" },
  });
  // A transcript update the harness reports past the limit is refused too, and the turn fails.
  await expect(
    acme.request("turn.completed", {
      runId: run.runId,
      status: "completed",
      state: {},
      output: "done",
      transcript: [{ keep: 0, entries: [{ role: "user", content: "y".repeat(8 * 1024) }], length: 1 }],
    })
  ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("recordEntryBytes") });
  const items = (await call(runtime, "GET", "/v1/sessions/s1/items")).body.items as {
    type: string;
    payload: Record<string, unknown>;
  }[];
  expect(items.filter((item) => item.type === "tool.completed").map((item) => item.payload.output)).toEqual(["ok"]);
});

it("refuses a pause from a custom harness", async () => {
  const { runtime, acme } = await start();
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run } = await leased;
  await expect(acme.request("turn.paused", { runId: run.runId, status: "paused" })).rejects.toMatchObject({
    code: "invalid",
  });
});

it("journals a tool the harness runs itself, and records a call that names no target as unavailable", async () => {
  const { runtime, acme } = await start();
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run, input } = (await leased) as {
    run: { runId: string; sessionId: string; turnId: string; token?: string };
    input: TurnStart;
  };
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const intent = (toolName: string, n: number, target?: EffectIntent["target"]): EffectIntent => ({
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    toolName,
    ...(target ? { target } : {}),
    input: { patch: "--- a\n+++ b" },
    context: { callId: `c${n}`, invocationId: `i${n}` },
  });
  const declared = intent("apply_patch", 1, { kind: "harness" });
  // With its span's context (R7.4), which the harness may hand to what it runs.
  await expect(
    acme.request("effect.intent", { runId: run.runId, effect: declared, requestHash: effectRequestHash(declared) })
  ).resolves.toEqual({ status: "execute", traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/) });
  // A Runtime token the harness's tool printed (its egress proxy, say): never recorded (HC14).
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const egress = `${part({ alg: "ES256", typ: "nylorun-egress+jwt" })}.${part({ sub: "env" })}.${"s".repeat(64)}`;
  await acme.request("effect.outcome", {
    runId: run.runId,
    effectId: declared.effectId,
    value: { kind: "completed", output: `patched; HTTPS_PROXY=http://nylorun:${egress}@egress:3128` },
  });
  const other = intent("rm_rf", 2);
  await expect(
    acme.request("effect.intent", { runId: run.runId, effect: other, requestHash: effectRequestHash(other) })
  ).resolves.toMatchObject({ status: "completed" });
  await acme.request("turn.completed", { runId: run.runId, status: "completed", state: { steps: 1 }, output: "done" });
  await until(() => view(runtime), (v) => v.status === "completed", "turn");

  const items = (await call(runtime, "GET", "/v1/sessions/s1/items")).body.items as {
    type: string;
    payload: Record<string, unknown>;
  }[];
  const completed = items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
  expect(completed).toEqual([
    expect.objectContaining({
      toolName: "apply_patch",
      // A tool the harness runs itself, by its target.
      kind: "harness",
      output: "patched; HTTPS_PROXY=http://nylorun:[nylorun token redacted]@egress:3128",
    }),
    expect.objectContaining({ toolName: "rm_rf", error: expect.objectContaining({ code: "tool.unavailable" }) }),
  ]);
});

it("says who wrote each event: the client's command, the harness's claims, core's own", async () => {
  const { runtime, acme } = await start();
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run, input } = (await leased) as { run: { runId: string; sessionId: string; turnId: string }; input: TurnStart };
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const intent = (toolName: string, n: number, target?: EffectIntent["target"]): EffectIntent => ({
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    toolName,
    ...(target ? { target } : {}),
    input: {},
    context: { callId: `c${n}`, invocationId: `i${n}` },
  });
  const declared = intent("apply_patch", 1, { kind: "harness" });
  await acme.request("effect.intent", { runId: run.runId, effect: declared, requestHash: effectRequestHash(declared) });
  await acme.request("effect.outcome", { runId: run.runId, effectId: declared.effectId, value: { kind: "completed", output: "ok" } });
  const other = intent("rm_rf", 2);
  await acme.request("effect.intent", { runId: run.runId, effect: other, requestHash: effectRequestHash(other) });
  await acme.request("turn.completed", { runId: run.runId, status: "completed", state: {}, output: "done" });
  await until(() => view(runtime), (v) => v.status === "completed", "turn");

  const items = (await call(runtime, "GET", "/v1/sessions/s1/items")).body.items as {
    type: string;
    source: { kind: string; id: string };
    evidence: string;
    runId: string | null;
    principal?: { kind: string; id: string };
    payload: Record<string, unknown>;
  }[];
  const by = (type: string, toolName?: string) =>
    items.find((item) => item.type === type && (toolName === undefined || item.payload.toolName === toolName))!;
  expect(by("command.message")).toMatchObject({
    source: { kind: "client" },
    evidence: "observed",
    principal: { kind: "application" },
  });
  expect(by("tool.completed", "apply_patch")).toMatchObject({
    source: { kind: "harness", id: "acme-mini" },
    evidence: "claimed",
    runId: run.runId,
  });
  expect(by("tool.completed", "rm_rf")).toMatchObject({ source: { kind: "core" }, evidence: "observed", runId: run.runId });
  expect(by("turn.completed")).toMatchObject({ source: { kind: "harness", id: "acme-mini" }, evidence: "claimed" });
  expect(by("agent.attached")).toMatchObject({ source: { kind: "core" }, evidence: "observed" });
});
