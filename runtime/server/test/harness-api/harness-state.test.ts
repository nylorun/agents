/**
 * Harness-owned state (R4.2): a custom harness's turn state is stored as it sent it, capped, and
 * handed back only to it; it cannot pause for approvals in Harness API 2; and the tools it
 * declares in `hello` are journaled like built-ins, so the log records what really ran.
 */
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_TOOLS_CAPABILITY,
  effectRequestHash,
  memoryChannels,
  type EffectIntent,
  type HarnessChannel,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { boot, openSession, server, until, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function attach(runtime: Started): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}

const patch = { name: "apply_patch", description: "Applies a patch", inputSchema: { type: "object" } };

async function call(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

/** A Runtime with only a custom harness, `acme-mini`, connected, and session s1 on its Environment. */
async function start() {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const acme = attach(runtime);
  await acme.request("hello", { api: 2, name: "acme-mini", version: "0", capabilities: { tools: [patch] } });
  expect((await call(runtime, "PUT", "/v1/environments/env-acme", { kind: "none", harness: "acme-mini" })).status).toBe(200);
  await openSession(runtime, "seed");
  expect(
    (await call(runtime, "PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: "u", environment: "env-acme" }))
      .status
  ).toBe(200);
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
  ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("state over 256 KiB") });
  await until(() => view(runtime), (v) => v.status === "failed" || v.status === "idle", "failed turn");
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

it("journals a tool the harness declared, and records an undeclared one as unavailable", async () => {
  const { runtime, acme } = await start();
  const leased = acme.request("lease", {});
  await message(runtime, 1);
  const { run, input } = (await leased) as {
    run: { runId: string; sessionId: string; turnId: string; token?: string };
    input: TurnStart;
  };
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const intent = (toolName: string, n: number): EffectIntent => ({
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    capabilityId: HARNESS_TOOLS_CAPABILITY,
    toolName,
    input: { patch: "--- a\n+++ b" },
    context: { callId: `c${n}`, invocationId: `i${n}` },
  });
  const declared = intent("apply_patch", 1);
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
  const intent = (toolName: string, n: number): EffectIntent => ({
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    capabilityId: HARNESS_TOOLS_CAPABILITY,
    toolName,
    input: {},
    context: { callId: `c${n}`, invocationId: `i${n}` },
  });
  const declared = intent("apply_patch", 1);
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
  expect(by("environment.attached")).toMatchObject({ source: { kind: "core" }, evidence: "observed" });
});
