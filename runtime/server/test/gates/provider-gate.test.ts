/**
 * A Model Gate over a provider (protocol 15): a scripted model is served like any, through a
 * gate. The provider sees the call as an effect rebuilt from the request; with a store each call
 * is metered, and the Tenant's fixture model setting is answered first. It never recovers.
 */
import { describe, expect, it } from "vitest";
import type { HostEffect } from "@nylorun/harness/run";
import { providerEffect, providerModelGate } from "../../src/gates/provider-gate.js";
import type { ModelGateRequest } from "../../src/gates/model-gate.js";
import type { RuntimeModelCall } from "../../src/contracts.js";
import { createTestSessionStore } from "../support/store.js";

const call = { prompt: [], tools: [], executionId: "s1" } as unknown as RuntimeModelCall;
const request: ModelGateRequest = {
  tenantId: "tn_test",
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  effectId: "t1:0:model:inv-1",
  invocationId: "inv-1",
  agent: { id: "helper", path: "helper", delegationId: "d1" },
  purpose: "summary",
  call,
};
const silent = { info() {}, warn() {}, error() {} };

describe("providerModelGate", () => {
  it("hands the provider the call as an effect, with its agent and purpose", async () => {
    const seen: HostEffect[] = [];
    const gate = providerModelGate(async (effect) => {
      seen.push(effect);
      return { output: [{ type: "text", text: "hi" }] };
    });
    expect(await gate.call(request, new AbortController().signal)).toEqual({ output: [{ type: "text", text: "hi" }] });
    expect(seen).toEqual([providerEffect(request)]);
    expect(seen[0]).toMatchObject({
      effectId: request.effectId,
      sessionId: "s1",
      turnId: "t1",
      agentId: "bot",
      kind: "model",
      agent: request.agent,
      purpose: "summary",
      input: call,
      context: { invocationId: "inv-1" },
    });
    expect(gate.recovers).toBeUndefined();
  });

  it("meters each call in the usage ledger when it has a store", async () => {
    const store = await createTestSessionStore();
    const gate = providerModelGate(
      async () => ({ output: [{ type: "text", text: "hi" }], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
      { store, logger: silent },
    );
    await gate.call({ ...request, effectId: "t1:0:model:metered" }, new AbortController().signal);
    const totals = await store.tx((t) => t.modelUsageTotals({ scope: "tenant" } as never));
    expect(totals).toMatchObject({ calls: 1 });
  });
});
