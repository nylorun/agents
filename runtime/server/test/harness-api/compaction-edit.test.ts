/**
 * Compaction is an explicit transcript edit (Q4, protocol 15): a harness marks the edit that
 * replaced older history with a summary (`kind: "compaction"`) and names the summary calls that
 * wrote it (`purpose: "summary"`). The record never parses the entries: it checks the calls, and
 * writes one `context.compacted` from the facts and the last call. A summary call is no
 * assistant message. A fake harness holds a real run over the memory channel.
 */
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  effectRequestHash,
  memoryChannels,
  type EffectIntent,
  type HarnessChannel,
  type RunGrant,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { boot, openSession, server, until, view, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Held {
  readonly runtime: Started;
  readonly harness: HarnessChannel;
  readonly run: RunGrant;
  readonly input: TurnStart;
}

async function hold(): Promise<Held> {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  const harness = channels.harness;
  await harness.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  await openSession(runtime, "s1");
  const leased = harness.request("lease", {});
  const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", parts: [{ type: "text", text: "go" }] }),
  });
  expect(sent.status).toBe(200);
  const { run, input } = await leased;
  return { runtime, harness, run, input };
}

/** A model call of the run, recorded with its outcome. */
async function modelCall(held: Held, identity: string, fields: Partial<EffectIntent> = {}) {
  const checkpoint = held.input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const effect: EffectIntent = {
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:model:${identity}`,
    sessionId: "s1",
    turnId: held.run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "model",
    context: { invocationId: identity },
    ...fields,
  };
  const call = { prompt: [], tools: [], executionId: "s1" };
  const { runId } = held.run;
  expect(
    await held.harness.request("effect.intent", { runId, effect, requestHash: effectRequestHash({ ...effect, input: call }) }),
  ).toEqual({ status: "execute" });
  await held.harness.request("effect.outcome", {
    runId,
    effectId: effect.effectId,
    value: { output: [{ type: "text", text: `## Goal\n${identity}` }] },
  });
  return effect.effectId;
}

async function items(runtime: Started) {
  const response = await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: server });
  return ((await response.json()) as { items: { type: string; payload: Record<string, unknown> }[] }).items;
}

const summaryEntry = (turnId: string) => ({
  kind: "compaction",
  turnId,
  stepId: "s1",
  summary: "## Goal\nsummary",
  trigger: "threshold",
  tokensBefore: 900,
  tokensAfter: 120,
});

it("writes one context.compacted for a compaction edit, from its facts and its last summary call", async () => {
  const held = await hold();
  const first = await modelCall(held, "compaction-s1", { purpose: "summary" });
  const last = await modelCall(held, "compaction-s1-1", { purpose: "summary" });
  const answered = await held.harness.request("turn.completed", {
    runId: held.run.runId,
    status: "completed",
    state: {},
    output: "done",
    transcript: [
      {
        kind: "compaction",
        keep: 0,
        entries: [summaryEntry(held.run.turnId)],
        length: 1,
        compaction: { trigger: "threshold", tokensBefore: 900, tokensAfter: 120, summaryEffectIds: [first, last] },
      },
    ],
  });
  expect(answered.cursor).toEqual(expect.any(Number));
  const log = await items(held.runtime);
  // A summary call is never an assistant message.
  expect(log.filter((item) => item.type === "message.assistant")).toEqual([]);
  const compacted = log.filter((item) => item.type === "context.compacted");
  expect(compacted).toHaveLength(1);
  expect(compacted[0]!.payload).toMatchObject({
    trigger: "threshold",
    tokensBefore: 900,
    tokensAfter: 120,
    invocationId: "compaction-s1-1",
    effectId: last,
  });
  expect(compacted[0]!.payload).not.toHaveProperty("partial");
});

it("refuses a compaction edit that names a call that wrote no summary, and the turn fails", async () => {
  const held = await hold();
  const plain = await modelCall(held, "step-1");
  await expect(
    held.harness.request("turn.completed", {
      runId: held.run.runId,
      status: "completed",
      state: {},
      output: "done",
      transcript: [
        {
          kind: "compaction",
          keep: 0,
          entries: [summaryEntry(held.run.turnId)],
          length: 1,
          compaction: { trigger: "overflow", tokensBefore: 1, tokensAfter: 1, summaryEffectIds: [plain] },
        },
      ],
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("is not a completed summary call of this turn") });
  await until(() => view(held.runtime, "s1"), (session) => session.status === "failed", "the turn to fail");
  expect((await items(held.runtime)).some((item) => item.type === "context.compacted")).toBe(false);
});
