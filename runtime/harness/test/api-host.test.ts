/**
 * R5.3: a tool call whose gate hop lost its answer is sent again with the same key. The host
 * asks core again with the same intent, and core counts the send: it answers `execute` again,
 * or the call's outcome once the call reached its cap.
 */
import { describe, expect, it } from "vitest";
import type { HarnessChannel } from "@nylorun/core/harness-api";
import { apiHost } from "../src/api/host.js";
import type { HarnessExecutors, HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";

class HopLost extends Error {}

const effect = {
  kind: "tool",
  effectId: "t1:0:tool:call-1",
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  toolName: "refund",
  input: { charge: "ch_1" },
  context: { callId: "call-1", invocationId: "inv-1" },
} as unknown as HostEffect;

function harness(options: { answers: ("execute" | "interrupted")[]; failures: number }) {
  const intents: unknown[] = [];
  const outcomes: unknown[] = [];
  let sends = 0;
  const channel = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === "effect.intent") {
        intents.push(params);
        const next = options.answers.shift() ?? "execute";
        return next === "execute"
          ? { status: "execute" }
          : {
              status: "completed",
              outcome: { value: { kind: "failed", code: "tool.interrupted" } },
            };
      }
      if (method === "effect.outcome") {
        outcomes.push(params);
        return { status: "completed", outcome: { value: params.value } };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HarnessChannel;
  const executors: HarnessExecutors = {
    model: async () => ({}),
    async tool() {
      sends += 1;
      if (sends <= options.failures) throw new HopLost("the gate hop lost the answer");
      return { kind: "completed", output: { refund: 1 } };
    },
    recovers: { model: false, tool: () => true },
    resends: (_effect, error) => error instanceof HopLost,
  };
  const run: HarnessRun = {
    runId: "r1",
    grant: {} as HarnessRun["grant"],
    start: { outcomes: [] } as unknown as HarnessRun["start"],
    signal: new AbortController().signal,
  };
  return {
    host: apiHost(channel, executors, run, { artifactPageBytes: 32 * 1024 }),
    intents,
    outcomes,
    sends: () => sends,
  };
}

describe("a tool call whose gate hop lost the answer (R5.3)", { timeout: 20_000 }, () => {
  it("asks core again with the same intent and sends the call again", async () => {
    const h = harness({ answers: ["execute", "execute"], failures: 1 });
    expect(await h.host.resolveEffect(effect)).toEqual({
      status: "completed",
      outcome: { value: { kind: "completed", output: { refund: 1 } } },
    });
    expect(h.sends()).toBe(2);
    expect(h.intents).toHaveLength(2);
    expect(h.intents[1]).toEqual(h.intents[0]);
    expect(h.outcomes).toHaveLength(1);
  });

  it("takes core's outcome once the call reached its cap, and sends nothing more", async () => {
    const h = harness({ answers: ["execute", "execute", "interrupted"], failures: 10 });
    expect(await h.host.resolveEffect(effect)).toEqual({
      status: "completed",
      outcome: { value: { kind: "failed", code: "tool.interrupted" } },
    });
    expect(h.sends()).toBe(2);
    expect(h.outcomes).toEqual([]);
  });
});
