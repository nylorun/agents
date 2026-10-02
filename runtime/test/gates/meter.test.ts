/**
 * The meter (`gates/meter.ts`, P1.3): what a call records in the usage ledger, and that the
 * ledger never fails the call.
 */
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { capReached, createMeter, periodStart, usageRow } from "../../src/gates/meter.js";
import type { ModelGateOutcome, ModelGateRequest } from "../../src/gates/model-gate.js";
import type { ModelBudgetRow, SessionStore } from "../../src/store/types.js";
import { createTestSessionStore } from "../support/store.js";

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
    const store = await createTestSessionStore();
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
    // The cap check fails open too, then the ledger write is logged.
    expect(warnings).toEqual([
      expect.objectContaining({ message: "the database is down" }),
      expect.objectContaining({ message: "the database is down" }),
    ]);
  });

  it("rethrows an aborted call without recording it", async () => {
    const store = await createTestSessionStore();
    const meter = createMeter({ logger: quiet });
    await expect(
      meter.call(store, request, async () => {
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");
    expect((await store.tx((t) => t.modelUsageTotals({ scope: "tenant" }))).calls).toBe(0);
  });
});

describe("caps", () => {
  const budget = (patch: Partial<ModelBudgetRow>): ModelBudgetRow => ({
    scope: "turn",
    scopeId: "*",
    period: null,
    limitUsd: null,
    limitTokens: null,
    updatedAt: at.toISOString(),
    ...patch,
  });

  /** A store with `budgets`, and a meter whose calls count how often the provider ran. */
  async function metered(budgets: ModelBudgetRow[], now = at) {
    const store = await createTestSessionStore();
    await store.tx((t) => t.putModelBudgets(budgets));
    const meter = createMeter({ logger: quiet, now: () => now });
    let calls = 0;
    const call = (overrides: Partial<ModelGateRequest> = {}, effect = `e${calls}`) =>
      meter.call(store, { ...request, effectId: effect, ...overrides }, async () => {
        calls += 1;
        return answered;
      });
    return { store, meter, call, calls: () => calls };
  }

  it("calls freely without budgets", async () => {
    const { call, calls } = await metered([]);
    for (let n = 0; n < 5; n += 1) await call();
    expect(calls()).toBe(5);
  });

  it("stops a turn at its token cap, naming the scope and the route", async () => {
    const { call, calls } = await metered([budget({ limitTokens: 40 })]);
    await call();
    await call();
    // 30 tokens recorded, under the cap: the call runs and overspends it (no reservation).
    expect(await call()).toBe(answered);
    expect(await call()).toEqual({
      kind: "failed",
      code: "budget_exhausted",
      retryable: false,
      message: "The turn's cap of 40 tokens is reached (45 used); raise it with PUT /v1/tenant/budgets",
    });
    expect(calls()).toBe(3);
    // Another turn starts from zero.
    expect(await call({ turnId: "turn-2" })).toBe(answered);
  });

  it("stops an agent at its daily USD cap, and counts only that agent and day", async () => {
    const { store, call } = await metered([
      budget({ scope: "agent", scopeId: "bot", period: "day", limitUsd: 0.004 }),
    ]);
    await store.tx((t) =>
      t.recordModelUsage({
        ...usageRow(request, answered, new Date("2030-05-16T23:59:59.000Z"))!,
        effectKey: "yesterday",
      }),
    );
    await call();
    expect(await call({ agentId: "other" })).toBe(answered);
    await call();
    expect(await call()).toMatchObject({
      code: "budget_exhausted",
      message: expect.stringMatching(/^Agent bot's daily cap of \$0\.004 is reached/),
    });
  });

  it("stops the Tenant at its monthly cap across agents and turns", async () => {
    const { call } = await metered([budget({ scope: "tenant", period: "month", limitTokens: 30 })]);
    await call({ agentId: "a", turnId: "t1" });
    await call({ agentId: "b", turnId: "t2" });
    expect(await call({ agentId: "c", turnId: "t3" })).toMatchObject({
      code: "budget_exhausted",
      message: expect.stringMatching(/^The Tenant's monthly cap of 30 tokens/),
    });
  });

  it("counts calls in flight at the scope's average cost", async () => {
    const { store, meter, call } = await metered([budget({ limitTokens: 40 })]);
    await call(); // 15 tokens, 1 call
    let release!: () => void;
    const held = meter.call(store, { ...request, effectId: "held" }, () =>
      new Promise((resolve) => (release = () => resolve(answered))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 15 recorded + 15 in flight = 30: one more fits.
    expect(await call()).toBe(answered);
    // 30 recorded + 15 in flight = 45: refused.
    expect(await call()).toMatchObject({ code: "budget_exhausted" });
    release();
    expect(await held).toBe(answered);
  });

  it("caps in USD only what has a price: a $0 endpoint passes a USD cap", () => {
    const free = { calls: 10, tokens: 10_000, costUsd: 0 };
    expect(capReached(budget({ limitUsd: 1 }), free, 0)).toBeUndefined();
    expect(capReached(budget({ limitUsd: 1, limitTokens: 5000 }), free, 0)).toMatch(/5000 tokens/);
  });

  it("lets the call through when the budgets can't be read", async () => {
    const warnings: string[] = [];
    const meter = createMeter({ logger: { ...quiet, warn: (m) => void warnings.push(m) } });
    const broken = { tx: async () => { throw new Error("down"); } } as unknown as SessionStore;
    expect(await meter.call(broken, request, async () => answered)).toBe(answered);
    expect(warnings).toEqual(["model_budget_check_failed", "model_usage_failed"]);
  });
});
