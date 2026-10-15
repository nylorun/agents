import { describe, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  HarnessApiError,
  RUNTIME_LIMIT_DEFAULTS,
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
    const b = JSON.parse(JSON.stringify({ context: a.context, ...a, toolName: undefined }));
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
            return { api: HARNESS_API_VERSION, tenantId: "tn_test", sandbox: { backend: null }, renewEveryMs: 10 };
          if (method === "lease.renew") throw new HarnessApiError("run_not_held", `${(params as any).runId} is not held`);
          throw new Error("boom");
        });
        const messages: unknown[] = [];
        harness.listen((method, params) => messages.push([method, params]));
        await expect(
          harness.request("hello", { api: HARNESS_API_VERSION, name: "test", version: "0", features: {} })
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

describe("Harness API 3", () => {
  it("names features in hello, not capabilities", async () => {
    const { validateParams } = await import("../src/harness-api/index.js");
    expect(HARNESS_API_VERSION).toBe(3);
    const hello = { api: 3, name: "h", version: "0" };
    expect(() =>
      validateParams("hello", {
        ...hello,
        features: { workspace: true, tools: [{ name: "browse", inputSchema: { type: "object" } }] },
      })
    ).not.toThrow();
    expect(() => validateParams("hello", { ...hello, capabilities: {} })).toThrow(HarnessApiError);
  });

  it("names a tool effect by its tool alone", async () => {
    const { EffectIntentSchema } = await import("../src/harness-api/index.js");
    const tool = effect({ kind: "tool", toolName: "bash", effectId: "t1:0:tool:c1", input: {} });
    expect(EffectIntentSchema.safeParse(tool).success).toBe(true);
    expect(EffectIntentSchema.safeParse({ ...tool, capabilityId: "nylorun.sandbox" }).success).toBe(false);
  });

  it("names an HTTP tool call by agent and tool, and an MCP server by its name", async () => {
    const { HttpCallBodySchema, McpServerRefSchema, McpToolRecordSchema } = await import(
      "../src/harness-api/index.js"
    );
    const call = HttpCallBodySchema.parse({ effectId: "e", turnId: "t1", tool: { toolName: "refund" }, input: {} });
    expect(call.tool).toEqual({ toolName: "refund" });
    expect(McpServerRefSchema.parse({ serverName: "docs", capabilityId: "mcp" } as never)).toEqual({
      serverName: "docs",
    });
    expect(McpToolRecordSchema.shape).not.toHaveProperty("capabilityId");
  });
});

describe("published contract (R4.5)", () => {
  it("derives effect ids from the turn and segment, and tells a segment's own", async () => {
    const { effectIdOf, isEffectIdOf } = await import("../src/harness-api/index.js");
    expect(effectIdOf("t1", 0, "model", "i1")).toBe("t1:0:model:i1");
    expect(isEffectIdOf("t1:0:tool:c1", "t1", 0)).toBe(true);
    expect(isEffectIdOf("t1:1:tool:c1", "t1", 0)).toBe(false);
    expect(isEffectIdOf("t10:0:tool:c1", "t1", 0)).toBe(false);
  });

  it("accepts trace context on turn.start, and refuses a malformed traceparent", async () => {
    const { TurnStartSchema } = await import("../src/harness-api/index.js");
    const start = {
      type: "turn.start",
      engine: "agent",
      manifest: {},
      checkpoint: {},
      outcomes: [],
      transcript: { cursor: 0 },
      options: { fixtureModel: false },
      routing: { rootManifest: {} },
      limits: RUNTIME_LIMIT_DEFAULTS,
    };
    expect(TurnStartSchema.safeParse(start).success).toBe(true);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(TurnStartSchema.safeParse({ ...start, trace: { traceparent } }).success).toBe(true);
    expect(TurnStartSchema.safeParse({ ...start, trace: { traceparent: "nope" } }).success).toBe(false);
  });

  it("checks gate bodies and the pod join with the published schemas", async () => {
    const { HostJoinRequestSchema, ModelCallBodySchema, ToolCallBodySchema } = await import(
      "../src/harness-api/index.js"
    );
    expect(
      ModelCallBodySchema.safeParse({ effectId: "t1:0:model:i1", invocationId: "i1", call: { prompt: [], tools: [] } })
        .success
    ).toBe(true);
    // The gate takes the session from the run token: a body naming it is refused.
    expect(
      ModelCallBodySchema.safeParse({
        effectId: "e",
        invocationId: "i",
        sessionId: "s1",
        call: { prompt: [], tools: [] },
      }).success
    ).toBe(false);
    expect(
      ToolCallBodySchema.safeParse({
        server: { serverName: "docs" },
        effectId: "e",
        name: "search",
        arguments: {},
      }).success
    ).toBe(true);
    expect(HostJoinRequestSchema.safeParse({ sandboxId: "web", podUid: "abc-1", joinToken: "t" }).success).toBe(true);
    expect(HostJoinRequestSchema.safeParse({ sandboxId: "web", podUid: "a b", joinToken: "t" }).success).toBe(false);
  });

  it("generates one JSON Schema document with every published schema and request", async () => {
    const { harnessApiJsonSchema } = await import("../src/harness-api/index.js");
    const document = harnessApiJsonSchema() as { $defs: Record<string, unknown>; title: string };
    expect(document.title).toBe(`Nylorun Harness API ${HARNESS_API_VERSION}`);
    for (const name of [
      "TurnStart",
      "TurnOutput",
      "EffectIntent",
      "ModelCallBody",
      "ToolCallBody",
      "HttpCallBody",
      "McpSnapshot",
      "TranscriptEntry",
      "HostJoinRequest",
      "HostJoinAnswer",
      "hello.params",
      "effect.intent.params",
      "cancel.params",
    ])
      expect(document.$defs, name).toHaveProperty([name]);
  });
});
