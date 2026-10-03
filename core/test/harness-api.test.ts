import { describe, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  HarnessApiError,
  applyUpdates,
  effectRequestHash,
  memoryChannels,
  requestIdentity,
  transcriptUpdates,
  type EffectIntent,
  type Frame,
} from "../src/harness-api/index.js";

const effect = (fields: Partial<EffectIntent> = {}): EffectIntent => ({
  effectId: "t1:0:model:i1",
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  kind: "model",
  input: { prompt: [{ role: "user", content: "hi" }] },
  context: { invocationId: "i1" },
  ...fields,
});

describe("effect request hash", () => {
  it("ignores key order and undefined members", () => {
    const a = effect();
    const b = JSON.parse(JSON.stringify({ context: a.context, ...a, capabilityId: undefined }));
    expect(effectRequestHash(b)).toBe(effectRequestHash(a));
    expect(effectRequestHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers the model prompt, so another prompt under the same id is drift", () => {
    expect(effectRequestHash(effect({ input: { prompt: [] } }))).not.toBe(effectRequestHash(effect()));
  });

  it("leaves a delegation's context out of its identity", () => {
    const started = effect({ kind: "delegation", context: { callId: "c1" } });
    expect(requestIdentity(started)).not.toHaveProperty("context");
    expect(effectRequestHash(started)).toBe(effectRequestHash({ ...started, context: {} }));
    expect(effectRequestHash(effect({ context: { invocationId: "i2" } }))).not.toBe(effectRequestHash(effect()));
  });
});

describe("transcript edits", () => {
  it("round-trip through applyUpdates", () => {
    const before = [{ n: 1 }, { n: 2 }];
    const after = [{ n: 1 }, { n: 3 }, { n: 4 }];
    expect(applyUpdates(before, transcriptUpdates(before, after))).toEqual(after);
    expect(transcriptUpdates(after, after)).toEqual([]);
  });
});

describe("memory channel", () => {
  for (const json of [false, true]) {
    describe(json ? "JSON" : "by reference", () => {
      it("answers requests, reports errors with their code, and carries messages", async () => {
        const frames: Frame[] = [];
        const { harness, core } = memoryChannels({ json, tap: (frame) => frames.push(frame) });
        core.handle(async (method, params) => {
          if (method === "hello")
            return { api: HARNESS_API_VERSION, sandbox: { backend: null }, renewEveryMs: 10 };
          if (method === "lease.renew") throw new HarnessApiError("run_not_held", `${(params as any).runId} is not held`);
          throw new Error("boom");
        });
        const messages: unknown[] = [];
        harness.listen((method, params) => messages.push([method, params]));
        await expect(
          harness.request("hello", { api: 1, name: "test", version: "0", capabilities: {} })
        ).resolves.toMatchObject({ renewEveryMs: 10 });
        await expect(harness.request("lease.renew", { runId: "r1" })).rejects.toMatchObject({
          code: "run_not_held",
          message: "r1 is not held",
        });
        await expect(harness.request("transcript.read", { runId: "r1" })).rejects.toMatchObject({
          code: "internal",
          message: "boom",
        });
        core.notify("cancel", { runId: "r1", reason: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(messages).toEqual([["cancel", { runId: "r1", reason: "cancel" }]]);
        expect(frames.filter((frame) => frame.t === "req")).toHaveLength(3);
      });

      it("aborts the other side's handler and rejects open requests on close", async () => {
        const { harness, core } = memoryChannels({ json });
        let served: AbortSignal | undefined;
        core.handle(
          (_method, _params, signal) =>
            new Promise((_, reject) => {
              served = signal;
              signal.addEventListener("abort", () => reject(signal.reason));
            })
        );
        const controller = new AbortController();
        const asked = harness.request("lease", {}, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort(new Error("gave up"));
        await expect(asked).rejects.toThrow("gave up");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(served?.aborted).toBe(true);

        const open = harness.request("lease", {});
        core.close("gone");
        await expect(open).rejects.toMatchObject({ code: "unavailable" });
        expect(harness.closed).toBe(true);
      });
    });
  }

  it("validates frames in JSON mode", async () => {
    const { harness, core } = memoryChannels({ json: true });
    core.handle(async () => ({}));
    await expect(harness.request("lease.renew", { runId: "" } as never)).rejects.toMatchObject({ code: "invalid" });
    await expect(
      harness.request("effect.intent", { runId: "r", effect: effect(), requestHash: "nope" })
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
