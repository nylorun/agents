/**
 * Model Gate contract (blueprint §15, P1.1). Every `ModelGate` runs this suite: the in-process
 * gate, and the HTTP client against the gates service. The provider is a stubbed global
 * `fetch`, which the gates service (in this test process) uses as well.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { RuntimeModelCall } from "../../src/contracts.js";
import type { ModelCallSettings, ModelGate, ModelGateRequest } from "../../src/gates/model-gate.js";
import type { HostModelSecret } from "../../src/vault/service.js";

/** What the gate under test serves from: the Tenant's host model and the call settings. */
export interface ModelGateHost {
  readonly readHostModel: () => Promise<HostModelSecret | undefined>;
  readonly settings: ModelCallSettings;
}

export interface ModelGateHarness {
  gate: ModelGate;
  /**
   * Who the calls are for, when the gate serves only that (the HTTP gate serves the sessions
   * its run tokens name, F5): merged into every request.
   */
  scope?: Partial<Pick<ModelGateRequest, "tenantId" | "sessionId" | "turnId" | "agentId">>;
  dispose?(): Promise<void>;
}

export type ModelGateFactory = (host: ModelGateHost) => Promise<ModelGateHarness>;

const secret = (key = "test-provider-secret"): HostModelSecret => ({
  provider: "custom",
  model: "test-model",
  baseUrl: "https://provider.invalid/v1",
  authType: "api_key",
  credential: { type: "api_key", key },
});

const call: RuntimeModelCall = {
  executionId: "exec-1",
  tools: [
    {
      name: "lookup",
      description: "Look something up",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
  prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hello" }] }],
};

const request = (overrides: Partial<ModelGateRequest> = {}): ModelGateRequest => ({
  tenantId: newTenantId(),
  sessionId: "session-1",
  turnId: "turn-1",
  agentId: "bot",
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call,
  ...overrides,
});

const fast: ModelCallSettings = { retryBaseDelayMs: 1 };

function completion(delta: unknown, usage?: unknown): Response {
  const chunks = [
    { id: "test", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A provider stream that never sends an event, and errors when its request is aborted. */
function hanging(options: RequestInit): Response {
  const signal = options.signal as AbortSignal;
  return new Response(
    new ReadableStream({
      start(stream) {
        signal.addEventListener("abort", () => stream.error(signal.reason));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function modelGateContract(name: string, factory: ModelGateFactory) {
  describe(`ModelGate contract: ${name}`, () => {
    const harnesses: ModelGateHarness[] = [];
    const open = async (host: Partial<ModelGateHost> = {}) => {
      const harness = await factory({
        readHostModel: host.readHostModel ?? (async () => secret()),
        settings: host.settings ?? fast,
      });
      harnesses.push(harness);
      const { gate, scope = {} } = harness;
      const scoped: ModelGate = {
        ...gate,
        call: (request, signal) => gate.call({ ...request, ...scope }, signal),
        ...(gate.cancel ? { cancel: (request) => gate.cancel!({ ...request, ...scope }) } : {}),
      };
      return scoped;
    };
    afterEach(async () => {
      vi.unstubAllGlobals();
      await Promise.all(harnesses.splice(0).map((harness) => harness.dispose?.()));
    });

    it("calls the provider with the vault key and maps text, tools and usage", async () => {
      const provider = vi.fn(async (_url: unknown, options: RequestInit) => {
        expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-provider-secret");
        const body = JSON.parse(String(options.body));
        expect(body.model).toBe("test-model");
        expect(body.tools?.[0]?.function?.name).toBe("lookup");
        return completion(
          { role: "assistant", content: "hi there" },
          { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        );
      });
      vi.stubGlobal("fetch", provider);
      const gate = await open();
      const outcome = await gate.call(request(), new AbortController().signal);
      expect(outcome).toMatchObject({
        output: [{ type: "text", text: "hi there" }],
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      });
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it("returns an auth failure when no model is configured", async () => {
      const provider = vi.fn();
      vi.stubGlobal("fetch", provider);
      const gate = await open({ readHostModel: async () => undefined });
      expect(await gate.call(request(), new AbortController().signal)).toMatchObject({
        kind: "failed",
        code: "auth",
        retryable: false,
      });
      expect(provider).not.toHaveBeenCalled();
    });

    it("retries a rate-limited call and returns the answer", async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls++;
          if (calls <= 2)
            return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
              status: 429,
              headers: { "retry-after-ms": "1" },
            });
          return completion({ role: "assistant", content: "after retry" });
        }),
      );
      const gate = await open();
      expect(await gate.call(request(), new AbortController().signal)).toMatchObject({
        output: [{ type: "text", text: "after retry" }],
      });
      expect(calls).toBe(3);
    });

    it.each([
      [503, "The server is overloaded", "overloaded", true],
      [401, "Incorrect API key provided", "auth", false],
      [400, "This model's maximum context length is 8192 tokens", "context_overflow", false],
    ] as const)("classifies a %s response as %s", async (status, message, code, retryable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status })),
      );
      const gate = await open();
      expect(await gate.call(request(), new AbortController().signal)).toMatchObject({
        kind: "failed",
        code,
        retryable,
      });
    });

    it("aborts an idle provider stream and reports a timeout after retrying", async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, options: RequestInit) => {
          calls++;
          return hanging(options);
        }),
      );
      const gate = await open({ settings: { idleTimeoutMs: 30, retryBaseDelayMs: 1, attempts: 2 } });
      expect(await gate.call(request(), new AbortController().signal)).toMatchObject({
        kind: "failed",
        code: "timeout",
        retryable: true,
      });
      expect(calls).toBe(2);
    });

    it("redacts the vault key from a failure message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { message: "denied gate-test-secret-key" } }), {
              status: 401,
            }),
        ),
      );
      const gate = await open({ readHostModel: async () => secret("gate-test-secret-key") });
      const outcome = await gate.call(request(), new AbortController().signal);
      expect(outcome).toMatchObject({ kind: "failed", code: "auth" });
      expect(JSON.stringify(outcome)).not.toContain("gate-test-secret-key");
    });

    it("throws, without calling the provider, when cancelled before the call", async () => {
      const provider = vi.fn();
      vi.stubGlobal("fetch", provider);
      const gate = await open();
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(gate.call(request(), controller.signal)).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
    });

    it("throws when cancelled during the call; the provider request is aborted (after cancel, for a recovering gate)", async () => {
      const controller = new AbortController();
      let upstream: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, options: RequestInit) => {
          upstream = options.signal as AbortSignal;
          setTimeout(() => controller.abort(new Error("cancelled")), 20);
          return hanging(options);
        }),
      );
      const gate = await open();
      const call = request();
      await expect(gate.call(call, controller.signal)).rejects.toThrow();
      // A gate whose calls outlive the caller (P1.2) stops one only on an explicit cancel.
      if (gate.recovers) {
        expect(upstream?.aborted).toBe(false);
        await gate.cancel!(call);
      }
      await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
    });
  });
}
