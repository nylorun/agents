import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  type ModelAdapter,
  type ModelCall,
  type TranscriptEntry,
} from "@nylorun/core/define";
import { compact, contextBudget, estimateTokens, findCut } from "../src/loop/compaction/index.js";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../src/run/index.js";

const text = (length: number, fill = "x") => fill.repeat(length);

function toolStep(turnId: string, n: number, size = 400): TranscriptEntry[] {
  return [
    {
      kind: "candidate",
      turnId,
      stepId: `${turnId}-s${n}`,
      candidate: {
        output: [
          { type: "text", text: text(size, "a") },
          { type: "tool-call", id: `${turnId}-c${n}`, name: "job", args: {} },
        ],
      },
    },
    {
      kind: "tool-results",
      turnId,
      stepId: `${turnId}-s${n}`,
      results: [
        { kind: "completed", callId: `${turnId}-c${n}`, toolName: "job", output: text(size, "r") },
      ],
    },
  ];
}

const input = (turnId: string, value: string): TranscriptEntry => ({
  kind: "input",
  turnId,
  event: { kind: "user-message", text: value },
});

/** A model that summarizes any compaction call and records every call it saw. */
function summarizer(calls: { call: ModelCall; invocationId: string }[]): ModelAdapter {
  return async (call, context) => {
    calls.push({ call, invocationId: context.invocationId });
    return { output: [{ type: "text", text: `summary #${calls.length}` }] };
  };
}

describe("compaction cut", () => {
  it("never starts the kept tail with tool results", () => {
    const transcript = [input("t1", "go"), ...toolStep("t1", 1), ...toolStep("t1", 2)];
    for (let keep = 1; keep < 1_000; keep += 37) {
      const cut = findCut(transcript, keep);
      expect(transcript[cut]?.kind).not.toBe("tool-results");
    }
  });

  it("keeps the previous summary out of the tail", () => {
    const transcript: TranscriptEntry[] = [
      {
        kind: "compaction",
        turnId: "t0",
        stepId: "s0",
        summary: "old",
        trigger: "threshold",
        tokensBefore: 10,
        tokensAfter: 5,
      },
      input("t1", "go"),
    ];
    expect(findCut(transcript, 1_000_000)).toBe(1);
  });
});

describe("compact", () => {
  it("summarizes older entries, keeps the current request, and drops what it summarized", async () => {
    const calls: { call: ModelCall; invocationId: string }[] = [];
    const transcript = [
      input("t1", "first task"),
      ...toolStep("t1", 1),
      input("t2", "the current request"),
      ...toolStep("t2", 1),
      ...toolStep("t2", 2),
      ...toolStep("t2", 3),
    ];
    const next = await compact({
      transcript,
      executionId: "session",
      turnId: "t2",
      stepId: "t2-s4",
      trigger: "threshold",
      budget: { contextWindow: 1_000, reserve: 100 },
      invoke: summarizer(calls),
      signal: new AbortController().signal,
    });
    expect(next).toBeDefined();
    expect(next![0]).toMatchObject({ kind: "compaction", summary: "summary #1" });
    // The current turn's request survives verbatim even though the cut fell after it.
    expect(next![1]).toEqual(input("t2", "the current request"));
    expect(next!.some((entry) => entry.kind === "input" && entry.turnId === "t1")).toBe(false);
    expect(next!.length).toBeLessThan(transcript.length);
    expect(calls[0]!.invocationId).toBe("compaction-t2-s4");
    expect(JSON.stringify(calls[0]!.call.prompt)).toContain("first task");
  });

  it("merges the previous summary into the next one", async () => {
    const calls: { call: ModelCall; invocationId: string }[] = [];
    const transcript: TranscriptEntry[] = [
      {
        kind: "compaction",
        turnId: "t1",
        stepId: "s",
        summary: "EARLIER SUMMARY",
        trigger: "threshold",
        tokensBefore: 1,
        tokensAfter: 1,
      },
      input("t2", "go"),
      ...toolStep("t2", 1),
      ...toolStep("t2", 2),
      ...toolStep("t2", 3),
    ];
    await compact({
      transcript,
      executionId: "session",
      turnId: "t3",
      stepId: "t3-s1",
      trigger: "overflow",
      budget: { contextWindow: 1_000, reserve: 100 },
      invoke: summarizer(calls),
      signal: new AbortController().signal,
    });
    const prompt = JSON.stringify(calls[0]!.call.prompt);
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("EARLIER SUMMARY");
    expect(calls[0]!.invocationId).toBe("compaction-t3-s1-overflow");
  });

  it("summarizes history larger than the window in chunks, merging as it goes", async () => {
    const calls: { call: ModelCall; invocationId: string }[] = [];
    const contexts: unknown[] = [];
    const transcript = [
      input("t1", "FIRST FACT: the port is 5433"),
      ...Array.from({ length: 12 }, (_, n) => toolStep("t1", n, 1_500)).flat(),
      input("t1", "keep going"),
    ];
    const invoke: ModelAdapter = async (call, context) => {
      calls.push({ call, invocationId: context.invocationId });
      contexts.push(context.compaction);
      return { output: [{ type: "text", text: `running summary ${calls.length}` }] };
    };
    const next = await compact({
      transcript,
      executionId: "session",
      turnId: "t2",
      stepId: "s9",
      trigger: "threshold",
      budget: { contextWindow: 4_000, reserve: 1_000 },
      invoke,
      signal: new AbortController().signal,
    });
    expect(calls.length).toBeGreaterThan(1);
    // Every summarizer input fits the window.
    for (const { call } of calls)
      expect(Math.ceil(JSON.stringify(call.prompt).length / 4)).toBeLessThan(4_000);
    // The first chunk holds the oldest fact; each later call merges the running summary.
    expect(JSON.stringify(calls[0]!.call.prompt)).toContain("FIRST FACT");
    for (const [index, { call }] of calls.entries())
      if (index > 0) expect(JSON.stringify(call.prompt)).toContain(`running summary ${index}`);
    expect(calls.map((c) => c.invocationId)).toEqual(
      calls.map((_, index) => (index === 0 ? "compaction-s9" : `compaction-s9-${index}`)),
    );
    // Only the last call completes the compaction.
    expect(contexts.slice(0, -1).every((c) => (c as { partial?: boolean }).partial)).toBe(true);
    expect((contexts.at(-1) as { partial?: boolean }).partial).toBeUndefined();
    expect(next![0]).toMatchObject({
      kind: "compaction",
      summary: `running summary ${calls.length}`,
    });
  });

  it("returns undefined when there is nothing older to summarize", async () => {
    const next = await compact({
      transcript: [input("t1", "go")],
      executionId: "session",
      turnId: "t1",
      stepId: "s1",
      trigger: "threshold",
      budget: { contextWindow: 100_000, reserve: 1_000 },
      invoke: summarizer([]),
      signal: new AbortController().signal,
    });
    expect(next).toBeUndefined();
  });

  it("reads the budget and estimate from the latest candidate", () => {
    const transcript: TranscriptEntry[] = [
      input("t1", "go"),
      {
        kind: "candidate",
        turnId: "t1",
        stepId: "s1",
        candidate: {
          output: [{ type: "text", text: "ok" }],
          usage: { totalTokens: 900 },
          evidence: { extras: { contextWindow: 16_384, maxOutputTokens: 2_048 } },
        },
      },
      input("t1", text(400)),
    ];
    expect(contextBudget(transcript)).toEqual({ contextWindow: 16_384, reserve: 2_048 });
    expect(estimateTokens(transcript)).toBe(900 + Math.ceil((400 + "[User]: ".length) / 4));
  });
});

describe("compaction in the turn loop", () => {
  const agent = () =>
    Agent({ id: "long", name: "Long" })
      .use({
        id: "jobs",
        tools: [{ name: "job", inputSchema: z.object({}), execute: async () => "unused" }],
      })
      .build();

  /**
   * A journaled host whose model makes `steps` tool calls, then answers. Its window is
   * `window` tokens: a larger prompt fails with context_overflow unless `report` is set,
   * in which case it also reports the window so the engine compacts before sending.
   */
  function host(options: { window: number; steps: number; report: boolean }) {
    const journal = new Map<string, EffectResolution>();
    const requests = new Map<string, HostEffect>();
    const kinds: string[] = [];
    let modelSteps = 0;
    const size = (call: ModelCall) => Math.ceil(JSON.stringify(call.prompt).length / 4);
    const resolveEffect: DurableHost["resolveEffect"] = async (effect) => {
      const recorded = journal.get(effect.effectId);
      if (recorded) {
        expect(effect).toEqual(requests.get(effect.effectId));
        return recorded;
      }
      requests.set(effect.effectId, effect);
      let value: unknown;
      if (effect.kind === "tool") value = { kind: "completed", output: text(1_200, "r") };
      else {
        const call = effect.input as ModelCall;
        const compaction = String(effect.context.invocationId).startsWith("compaction-");
        kinds.push(compaction ? "compaction" : "model");
        const tokens = size(call);
        if (!compaction && tokens > options.window)
          value = {
            kind: "failed",
            code: "context_overflow",
            message: `prompt is too long: ${tokens} tokens > ${options.window} maximum`,
            retryable: false,
          };
        else if (compaction) value = { output: [{ type: "text", text: "summary of the work" }] };
        else {
          const index = modelSteps++;
          value = {
            output:
              index < options.steps
                ? [
                    { type: "text", text: text(600, "a") },
                    { type: "tool-call", id: `c${index}`, name: "job", args: {} },
                  ]
                : [{ type: "text", text: "done" }],
            usage: { totalTokens: tokens + 200 },
            ...(options.report
              ? {
                  evidence: {
                    extras: { contextWindow: options.window, maxOutputTokens: 512 },
                  },
                }
              : {}),
          };
        }
      }
      const resolution: EffectResolution = { status: "completed", outcome: { value } };
      journal.set(effect.effectId, resolution);
      return resolution;
    };
    return { host: { resolveEffect } satisfies DurableHost, kinds };
  }

  it("compacts before a call that would not fit, and the turn completes", async () => {
    const manifest = agent().manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const { host: journaled, kinds } = host({ window: 4_000, steps: 20, report: true });
    const result = await runDurable({ manifest, checkpoint, host: journaled });
    expect(result.status).toBe("completed");
    expect(kinds).toContain("compaction");
    // Every model call fitted: proactive compaction ran before each would-be overflow.
    expect(kinds.filter((kind) => kind === "model")).toHaveLength(21);
    const state = (result as { result: { state: { transcript: TranscriptEntry[] } } }).result.state;
    expect(state.transcript[0]?.kind).toBe("compaction");
    expect(estimateTokens(state.transcript)).toBeLessThan(4_000);

    // Replaying the same segment from the journal reaches the same state.
    const replay = await runDurable({ manifest, checkpoint, host: journaled });
    expect(replay).toEqual(result);
  });

  it("compacts once and retries when the provider reports an overflow", async () => {
    const manifest = agent().manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const { host: journaled, kinds } = host({ window: 3_000, steps: 12, report: false });
    const result = await runDurable({ manifest, checkpoint, host: journaled });
    expect(result.status).toBe("completed");
    const overflowRetries = kinds.filter((kind) => kind === "compaction").length;
    expect(overflowRetries).toBeGreaterThan(0);
  });
});
