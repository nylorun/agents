/**
 * The gates service's listener (`host/gates.ts`, `api/gate/routes.ts`) on 127.0.0.1:0, with
 * in-memory Tenant vaults and the provider stubbed as the global `fetch`. Requests to the gate
 * use the real `fetch`, captured before any stub.
 */
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { MODEL_CALLS_PATH } from "../../src/gates/contract.js";
import { GateRefusal, type TenantVaults } from "../../src/gates/tenant-vaults.js";
import { failure } from "../../src/model/classify.js";
import { GATES_REQUEST_TIMEOUT_MS, startGates, type GatesServer } from "../../src/host/gates.js";
import { MemorySessionStore } from "../../src/store/memory.js";
import type { HostModelSecret } from "../../src/vault/service.js";

const realFetch = globalThis.fetch;
const token = "cd".repeat(32);
const tenantId = newTenantId();
const secret: HostModelSecret = {
  provider: "custom",
  model: "test-model",
  baseUrl: "https://provider.invalid/v1",
  authType: "api_key",
  credential: { type: "api_key", key: "gate-host-secret" },
};
const body = {
  sessionId: "session-1",
  turnId: "turn-1",
  agentId: "bot",
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call: {
    executionId: "exec-1",
    tools: [],
    prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hi" }] }],
  },
};

const ledger = new MemorySessionStore({ tenantId });
const vaults: TenantVaults = {
  async open(id) {
    if (id !== tenantId)
      throw new GateRefusal(failure("transient", `Tenant ${id} is at schema version 1`, true));
    return {
      store: ledger,
      root: "/nonexistent-tenant-home",
      readHostModel: async () => secret,
      writeHostCredential: async () => {},
    };
  },
};

const logs: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }),
  warn: () => {},
  error: () => {},
};

const servers: GatesServer[] = [];
async function gate(options: { maxBodyBytes?: number } = {}) {
  const server = await startGates({
    gates: {
      listen: { host: "127.0.0.1", port: 0, allowedHosts: ["gateway:4100"] },
      token,
    },
    logger,
    vaults,
    settings: { retryBaseDelayMs: 1 },
    drainMs: 200,
    ...options,
  });
  servers.push(server);
  return server;
}

function post(
  server: GatesServer,
  init: {
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Sends `Idempotency-Key` (the effect id); default true. */
    keyed?: boolean;
  } = {},
) {
  return realFetch(`${server.url}${MODEL_CALLS_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "nylorun-tenant": tenantId,
      ...(init.keyed === false ? {} : { "idempotency-key": body.effectId }),
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

function completion(text: string): Response {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(
    `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  logs.length = 0;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("the gates service", () => {
  it("serves a model call and answers {outcome} once it has finished", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion("from the gate")));
    const server = await gate();
    const response = await post(server);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: { output: [{ type: "text", text: "from the gate" }] },
    });
    expect(logs).toContainEqual({
      message: "model_call",
      fields: expect.objectContaining({ tenant: tenantId, effect: body.effectId, outcome: "ok" }),
    });
    expect(JSON.stringify(logs)).not.toContain("gate-host-secret");
    expect(JSON.stringify(logs)).not.toContain("from the gate");
  });

  it("refuses a missing or wrong token with 401 gate_unauthorized", async () => {
    const server = await gate();
    for (const authorization of ["", `Bearer ${"ef".repeat(32)}`]) {
      const response = await post(server, { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "gate_unauthorized" } });
    }
  });

  it("answers 421 to a Host it doesn't serve, and serves the configured one", async () => {
    const server = await gate();
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${server.url}/health`, { headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status("evil.example:4100")).toBe(421);
    expect(await status("gateway:4100")).toBe(200);
  });

  it("refuses a bad Tenant header, malformed JSON, a malformed call and an oversized body", async () => {
    const server = await gate({ maxBodyBytes: 2048 });
    const cases: [Parameters<typeof post>[1], RegExp][] = [
      [{ headers: { "nylorun-tenant": "../../etc" } }, /must name a Tenant/],
      [{ body: "{not json" }, /must be JSON/],
      [{ body: { ...body, call: { tools: [] } } }, /Invalid model call/],
      [{ body: { ...body, padding: "x".repeat(4096) } }, /at most 2048 bytes/],
    ];
    for (const [init, message] of cases) {
      const response = await post(server, init);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(message);
    }
  });

  it("answers a refused Tenant with its failure outcome, without calling the provider", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const server = await gate();
    const response = await post(server, { headers: { "nylorun-tenant": newTenantId() } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: { kind: "failed", code: "transient", retryable: true },
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("aborts the provider request when the caller of an unkeyed call goes away", async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        upstream = init.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(stream) {
              upstream!.addEventListener("abort", () => stream.error(upstream!.reason));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const server = await gate();
    const caller = new AbortController();
    const pending = post(server, { signal: caller.signal, keyed: false }).catch(() => undefined);
    await vi.waitFor(() => expect(upstream).toBeDefined());
    caller.abort();
    await pending;
    await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
  });

  describe("keyed calls (P1.2)", () => {
    /** A provider whose answer the test releases, counting calls. */
    function heldProvider() {
      let calls = 0;
      let upstream: AbortSignal | undefined;
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          calls += 1;
          upstream = init.signal as AbortSignal;
          await Promise.race([
            released,
            new Promise((_, reject) =>
              upstream!.addEventListener("abort", () => reject(upstream!.reason)),
            ),
          ]);
          return completion("survived");
        }),
      );
      return { calls: () => calls, upstream: () => upstream, release };
    }

    it("keeps a call running after its caller goes away; a re-send gets its outcome", async () => {
      const provider = heldProvider();
      const server = await gate();
      const caller = new AbortController();
      const first = post(server, { signal: caller.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      caller.abort();
      await first;
      expect(provider.upstream()?.aborted).toBe(false);
      provider.release();
      const resent = await post(server);
      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({
        outcome: { output: [{ type: "text", text: "survived" }] },
      });
      expect(provider.calls()).toBe(1);
    });

    it("joins a call still running when the same request is re-sent", async () => {
      const provider = heldProvider();
      const server = await gate();
      const first = post(server);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const second = post(server);
      provider.release();
      expect((await (await first).json()).outcome.output[0].text).toBe("survived");
      expect((await (await second).json()).outcome.output[0].text).toBe("survived");
      expect(provider.calls()).toBe(1);
    });

    it("answers 409 gate_conflict to a different request under the same key", async () => {
      const provider = heldProvider();
      const server = await gate();
      const first = post(server);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const changed = await post(server, { body: { ...body, invocationId: "2" } });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "gate_conflict" } });
      provider.release();
      await first;
    });

    it("cancels a keyed call by effect id, aborting the provider request", async () => {
      const provider = heldProvider();
      const server = await gate();
      const first = post(server).catch(() => undefined);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const cancelled = await realFetch(
        `${server.url}${MODEL_CALLS_PATH}/${encodeURIComponent(body.effectId)}/cancel`,
        { method: "POST", headers: { authorization: `Bearer ${token}`, "nylorun-tenant": tenantId } },
      );
      expect(cancelled.status).toBe(204);
      await vi.waitFor(() => expect(provider.upstream()?.aborted).toBe(true));
      await first;
      const unauthorized = await realFetch(
        `${server.url}${MODEL_CALLS_PATH}/x/cancel`,
        { method: "POST", headers: { "nylorun-tenant": tenantId } },
      );
      expect(unauthorized.status).toBe(401);
    });
  });

  it("never times out a request before the longest model call", async () => {
    const server = await gate();
    expect(GATES_REQUEST_TIMEOUT_MS).toBeGreaterThan(630_000);
    expect(server.server.requestTimeout).toBe(GATES_REQUEST_TIMEOUT_MS);
    expect(server.server.timeout).toBe(0);
  });

  it("reports health and readiness", async () => {
    const server = await gate();
    const health = await realFetch(`${server.url}/health`);
    expect(await health.json()).toEqual({ status: "ok" });
    const ready = await realFetch(`${server.url}/ready`);
    expect(ready.status).toBe(200);
  });
});
