import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import {
  effectRequestHash,
  memoryChannels,
  type RecordedOutcome,
  type TurnStart,
} from "@nylorun/core/harness-api";
import {
  createHarness,
  runAbortKind,
  type Harness,
  type HarnessExecutors,
} from "../../src/api/index.js";
import { createDurableCheckpoint, type HostEffect } from "../../src/run/index.js";

const manifest = Agent({ id: "bot", name: "Bot" }).build().manifest;

function start(fields: Partial<TurnStart> & { checkpoint?: unknown } = {}): TurnStart {
  return {
    type: "turn.start",
    engine: "agent",
    manifest,
    checkpoint: createDurableCheckpoint({ manifest, sessionId: "s1", turnId: "t1", input: "go" }),
    sessionTools: [],
    outcomes: [],
    transcript: { cursor: -1 },
    options: { fixtureModel: false },
    routing: { rootManifest: manifest },
    ...fields,
  };
}

/** A fake core: offers the given starts in order and records every request. */
function fakeCore(options: {
  answer?: (method: string, params: any) => unknown;
  renewEveryMs?: number;
}) {
  const channels = memoryChannels({ json: true });
  const calls: [string, any][] = [];
  const outputs: any[] = [];
  const offers: { start: TurnStart; turnId: string }[] = [];
  const leases: ((value: unknown) => void)[] = [];
  let runs = 0;
  const flush = () => {
    while (offers.length && leases.length) {
      const offer = offers.shift()!;
      runs += 1;
      leases.shift()!({
        run: { runId: `r${runs}`, sessionId: "s1", turnId: offer.turnId, epoch: 1 },
        input: offer.start,
      });
    }
  };
  let settled: (() => void) | undefined;
  channels.core.handle(async (method, params) => {
    calls.push([method, params]);
    const custom = options.answer?.(method, params);
    if (custom !== undefined) return custom;
    switch (method) {
      case "hello":
        return {
          api: 1,
          tenantId: "tn_test",
          sandbox: { backend: null },
          renewEveryMs: options.renewEveryMs ?? 1000,
        };
      case "lease":
        return new Promise((resolve) => {
          leases.push(resolve);
          flush();
        });
      case "effect.intent":
        return { status: "execute" };
      case "effect.outcome":
        return "value" in params
          ? { status: "completed", outcome: { value: params.value } }
          : { status: "uncertain" };
      case "lease.renew":
        return { ok: true };
      case "transcript.read":
        return { cursor: 3, entries: [] };
      case "lease.release":
        return {};
      default:
        outputs.push([method, params]);
        settled?.();
        return { cursor: 7 };
    }
  });
  return {
    channel: channels.harness,
    calls,
    outputs,
    /** Core's `cancel` of a run, as core sends it when it aborts the advance. */
    cancel(runId: string, reason: "cancel" | "shutdown") {
      channels.core.notify("cancel", { runId, reason });
    },
    offer(turnStart: TurnStart, turnId = "t1") {
      const done = new Promise<void>((resolve) => (settled = resolve));
      offers.push({ start: turnStart, turnId });
      flush();
      return done;
    },
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

function executors(
  model: HarnessExecutors["model"],
  fields: Partial<HarnessExecutors> = {},
): HarnessExecutors {
  return {
    model,
    tool: async () => "tool",
    recovers: { model: false, remoteMcp: () => false },
    ...fields,
  };
}

async function harnessFor(core: ReturnType<typeof fakeCore>, run: HarnessExecutors) {
  const harness = createHarness({ channel: core.channel, executors: run });
  harnesses.push(harness);
  await harness.start();
  return harness;
}

describe("a harness", () => {
  it("runs a leased turn: the prompt stays here, and the output carries edits and a lean state", async () => {
    const core = fakeCore({});
    const prompts: unknown[] = [];
    await harnessFor(
      core,
      executors(async (effect) => {
        prompts.push(effect.input);
        return { output: [{ type: "text", text: "hi" }] };
      }),
    );
    await core.offer(start());
    const intents = core.calls.filter(([method]) => method === "effect.intent");
    expect(intents).toHaveLength(1);
    expect(intents[0]![1].effect).not.toHaveProperty("input");
    expect(prompts).toHaveLength(1);
    expect(intents[0]![1].requestHash).toBe(
      effectRequestHash({ ...intents[0]![1].effect, input: prompts[0] }),
    );
    const [[method, output]] = core.outputs;
    expect(method).toBe("turn.completed");
    expect(output.state.transcript).toEqual([]);
    expect(output.transcript.length).toBeGreaterThan(0);
    expect(output.output).toBe("hi");
  });

  it("resumes from its cached transcript at the settled cursor, and reads it otherwise", async () => {
    const core = fakeCore({});
    await harnessFor(
      core,
      executors(async () => "done"),
    );
    await core.offer(start());
    const [, first] = core.outputs[0]!;
    const resumed = (cursor: number, turnId: string) =>
      start({
        transcript: { cursor },
        checkpoint: {
          ...createDurableCheckpoint({ manifest, sessionId: "s1", turnId, input: "again" }),
          state: first.state,
        },
      });
    await core.offer(resumed(7, "t2"), "t2");
    expect(core.calls.filter(([method]) => method === "transcript.read")).toHaveLength(0);
    await core.offer(resumed(9, "t3"), "t3");
    expect(core.calls.filter(([method]) => method === "transcript.read")).toHaveLength(1);
  });

  it("replays recorded outcomes without asking, and fails the step on drift", async () => {
    const core = fakeCore({});
    let calls = 0;
    await harnessFor(
      core,
      executors(async () => {
        calls += 1;
        return "done";
      }),
    );
    // Learn the model effect's id and hash from a first run.
    await core.offer(start());
    const intent = core.calls.find(([method]) => method === "effect.intent")![1];
    const outcome: RecordedOutcome = {
      effectId: intent.effect.effectId,
      requestHash: intent.requestHash,
      outcome: { value: "recorded" },
    };
    core.calls.length = 0;
    await core.offer(start({ outcomes: [outcome] }));
    expect(core.calls.filter(([method]) => method === "effect.intent")).toHaveLength(0);
    expect(calls).toBe(1);
    expect(core.outputs[1]).toMatchObject(["turn.completed", { output: "recorded" }]);

    await core.offer(start({ outcomes: [{ ...outcome, requestHash: "0".repeat(64) }] }));
    expect(core.outputs[2]).toMatchObject([
      "turn.failed",
      { status: "failed", error: { message: "Effect identity request drift" } },
    ]);
  });

  it("aborts a run with core's reason, and gives it back when it loses the lease", async () => {
    let refuse = false;
    const core = fakeCore({
      renewEveryMs: 20,
      answer: (method) => (method === "lease.renew" && refuse ? { ok: false } : undefined),
    });
    const seen: unknown[] = [];
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    await harnessFor(
      core,
      executors(
        (_effect, signal) =>
          new Promise((_, reject) => {
            entered();
            signal.addEventListener("abort", () => {
              seen.push(runAbortKind(signal));
              reject(signal.reason);
            });
          }),
      ),
    );
    const released = core.offer(start());
    await called;
    refuse = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual(["ownership.lost"]);
    expect(
      core.calls.some(
        ([method, params]) => method === "lease.release" && params.reason === "ownership.lost",
      ),
    ).toBe(true);
    expect(core.outputs).toEqual([]);
    void released;
  });

  it("leaves a recoverable call at its gate on shutdown, recording nothing", async () => {
    const core = fakeCore({});
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    const harness = await harnessFor(
      core,
      executors(
        (_effect: HostEffect, signal) =>
          new Promise((_, reject) => {
            entered();
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
        { recovers: { model: true, remoteMcp: () => false } },
      ),
    );
    void core.offer(start());
    await called;
    await harness.stop();
    expect(core.calls.filter(([method]) => method === "effect.outcome")).toEqual([]);
    expect(core.calls.at(-1)).toEqual(["lease.release", { runId: "r1", reason: "shutdown" }]);
  });

  it("does not hold a run core stopped while it asked about a pending Action", async () => {
    const withTool = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "work",
        tools: [{ name: "note", inputSchema: z.object({}), execute: async () => "unused" }],
      })
      .build().manifest;
    let asked!: () => void;
    const asking = new Promise<void>((resolve) => (asked = resolve));
    let answer!: (value: unknown) => void;
    const core = fakeCore({
      answer: (method, params) => {
        if (method !== "effect.intent" || params.effect.kind !== "tool") return undefined;
        asked();
        // Core answers `pending` once the endpoint has the Action, after it stopped the run.
        return new Promise((resolve) => (answer = resolve));
      },
    });
    await harnessFor(
      core,
      executors(async () => ({
        output: [{ type: "tool-call", id: "call-1", name: "note", args: {} }],
      })),
    );
    void core.offer(
      start({
        manifest: withTool,
        checkpoint: createDurableCheckpoint({
          manifest: withTool,
          sessionId: "s1",
          turnId: "t1",
          input: "go",
        }),
        options: { fixtureModel: false, holdMs: 60_000 },
        routing: { rootManifest: withTool },
      }),
    );
    await asking;
    core.cancel("r1", "shutdown");
    await new Promise((resolve) => setTimeout(resolve, 10));
    answer({ status: "pending" });
    const deadline = Date.now() + 2_000;
    while (!core.calls.some(([method]) => method === "lease.release") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(core.calls.at(-1)).toEqual(["lease.release", { runId: "r1", reason: "shutdown" }]);
    expect(core.outputs).toEqual([]);
  });
});
