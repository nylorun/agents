/**
 * The meter (`gates/meter.ts`, P1.3): what a call records in the usage ledger, and that the
 * ledger never fails the call.
 */
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createMeter, periodStart, usageRow } from "../../src/gates/meter.js";
import type { ModelGateOutcome, ModelGateRequest } from "../../src/gates/model-gate.js";
import { MemorySessionStore } from "../../src/store/memory.js";
import type { SessionStore } from "../../src/store/types.js";

const request: ModelGateRequest = {
  tenantId: newTenantId(),
  sessionId: "s1",
  turnId: "turn-1",
  agentId: "bot",
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call: { executionId: "e", tools: [], prompt: [] },
};

const answered: ModelGateOutcome = {
  output: [{ type: "text", text: "hi" }],
  finishReason: "stop",
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedTokens: 4, costUsd: 0.002 },
  evidence: {
    resolvedModel: "gpt-test-2026",
    extras: { producer: { provider: "openai", api: "openai-responses", model: "gpt-test" } },
  },
};

const at = new Date("2030-05-17T13:45:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };

describe("usageRow", () => {
  it("records the call's ids, the producer and the usage", () => {
    expect(usageRow(request, answered, at)).toEqual({
      id: expect.any(String),
      effectKey: "turn-1:0:model:1",
      sessionId: "s1",
      turnId: "turn-1",
      agentId: "bot",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedTokens: 4,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.002,
      createdAt: "2030-05-17T13:45:00.000Z",
    });
  });

  it("records nothing for a failure, or an answer without usage", () => {
    expect(usageRow(request, { kind: "failed", code: "auth", message: "no", retryable: false }, at)).toBeUndefined();
    expect(usageRow(request, { output: [], finishReason: "stop" }, at)).toBeUndefined();
  });

  it("sums input and output when the provider sent no total", () => {
    const row = usageRow(request, { output: [], usage: { inputTokens: 7, outputTokens: 2 } }, at);
    expect(row).toMatchObject({ totalTokens: 9, costUsd: 0, provider: null, model: null });
  });
});

describe("periodStart", () => {
  it("is the start of the UTC day or month", () => {
    expect(periodStart("day", at)).toBe("2030-05-17T00:00:00.000Z");
    expect(periodStart("month", at)).toBe("2030-05-01T00:00:00.000Z");
  });
});

describe("createMeter", () => {
  it("records an answered call once, and a re-run of the same effect as a duplicate", async () => {
    const store = new MemorySessionStore({ tenantId: request.tenantId });
    const warnings: string[] = [];
    const meter = createMeter({ logger: { ...quiet, warn: (m) => void warnings.push(m) }, now: () => at });
    expect(await meter.call(store, request, async () => answered)).toBe(answered);
    expect(await store.tx((t) => t.modelUsageTotals({ scope: "turn", id: "turn-1" }))).toEqual({
      calls: 1,
      tokens: 15,
      costUsd: 0.002,
    });
    await meter.call(store, request, async () => answered);
    expect(warnings).toEqual(["model_usage_duplicate"]);
  });

  it("returns the outcome when the ledger write fails, and logs it", async () => {
    const broken = {
      tx: async () => {
        throw new Error("the database is down");
      },
    } as unknown as SessionStore;
    const warnings: Record<string, unknown>[] = [];
    const meter = createMeter({ logger: { ...quiet, warn: (_m, fields) => void warnings.push(fields!) } });
    expect(await meter.call(broken, request, async () => answered)).toBe(answered);
    expect(warnings).toEqual([expect.objectContaining({ message: "the database is down" })]);
  });

  it("rethrows an aborted call without recording it", async () => {
    const store = new MemorySessionStore({ tenantId: request.tenantId });
    const meter = createMeter({ logger: quiet });
    await expect(
      meter.call(store, request, async () => {
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");
    expect((await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).calls).toBe(0);
  });
});
