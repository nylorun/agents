/**
 * The gates service's listener (`host/gates.ts`, `api/gate/routes.ts`) on 127.0.0.1:0, with
 * stub Tenant vaults (the ledger, signing keys and sessions on the file's database) and the
 * provider stubbed as the global `fetch`. Requests to the gate use the real `fetch`, captured
 * before any stub. Model calls carry a session's run token (F5), minted as an advance would.
 */
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newArtifactId, newTenantId } from "@nylorun/core/compatibility";
import { createFsBlobStore, type BlobStore } from "../../src/blob/index.js";
import { MODEL_CALLS_PATH } from "../../src/gates/contract.js";
import { GateRefusal, type TenantVaults } from "../../src/gates/tenant-vaults.js";
import { failure } from "../../src/model/classify.js";
import { GATES_REQUEST_TIMEOUT_MS, startGates, type GatesServer } from "../../src/host/gates.js";
import { KEYS_PATH } from "../../src/keys/contract.js";
import { DELIVERIES_PATH } from "../../src/gates/tool-contract.js";
import type { HostModelSecret } from "../../src/vault/service.js";
import type { RunGrant } from "../../src/tenant/run-token.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

const realFetch = globalThis.fetch;
const token = "cd".repeat(32);
const secret: HostModelSecret = {
  provider: "custom",
  model: "test-model",
  baseUrl: "https://provider.invalid/v1",
  authType: "api_key",
  credential: { type: "api_key", key: "gate-host-secret" },
};
const body = {
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call: {
    executionId: "exec-1",
    tools: [],
    prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hi" }] }],
  },
};

// The ledger, the signing keys and the sessions: a Session Store on the test file's database.
let runs: RunFixture;
let tenantId: string;
beforeAll(async () => {
  runs = await runFixture();
  tenantId = runs.tenantId;
});
/** A session running turn-1 under a fresh lease, and its run token. */
let sessions = 0;
const running = (options: { agentId?: string } = {}) => runs.run(`session-${++sessions}`, options);

const vaults: TenantVaults = {
  async open(id) {
    if (id !== undefined && id !== tenantId)
      throw new GateRefusal(
        failure("invalid_request", `Tenant ${id} is not this installation's Tenant`, false),
      );
    return {
      tenantId,
      store: runs.store,
      root: "/nonexistent-tenant-home",
      readHostModel: async () => secret,
      writeHostCredential: async () => {},
      keys: () => runs.keys,
    } as never;
  },
};

const logs: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }),
  warn: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }),
  error: () => {},
};

const servers: GatesServer[] = [];
async function gate(options: { maxBodyBytes?: number; blobs?: BlobStore } = {}) {
  const server = await startGates({
    gates: {
      listen: { host: "127.0.0.1", port: 0, allowedHosts: ["gateway:4100"] },
      token,
    },
    logger,
    vaults,
    settings: { retryBaseDelayMs: 1 },
    drainMs: 200,
    keys: true,
    ...options,
  });
  servers.push(server);
  return server;
}

function post(
  server: GatesServer,
  grant: RunGrant | undefined,
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
      ...(grant ? { authorization: `Bearer ${grant.token}` } : {}),
      "nylorun-tenant": tenantId,
      ...(init.keyed === false ? {} : { "idempotency-key": body.effectId }),
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

const cancel = (server: GatesServer, bearer: string | undefined, key = body.effectId) =>
  realFetch(`${server.url}${MODEL_CALLS_PATH}/${encodeURIComponent(key)}/cancel`, {
    method: "POST",
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "nylorun-tenant": tenantId },
  });

function completion(text: string, usage?: unknown): Response {
  const chunk = (delta: unknown, finish: string | null, extra = {}) =>
    `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  return new Response(
    `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop", usage ? { usage } : {})}data: [DONE]\n\n`,
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
    const grant = await running();
    const response = await post(server, grant);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: { output: [{ type: "text", text: "from the gate" }] },
    });
    expect(logs).toContainEqual({
      message: "model_call",
      fields: expect.objectContaining({
        tenant: tenantId,
        session: grant.claims.sessionId,
        effect: body.effectId,
        outcome: "ok",
      }),
    });
    expect(JSON.stringify(logs)).not.toContain("gate-host-secret");
    expect(JSON.stringify(logs)).not.toContain("from the gate");
    expect(JSON.stringify(logs)).not.toContain(grant.token);
  });

  it("reads a file part only from the run token's session (protocol 6)", async () => {
    const providerBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerBodies.push(String(init?.body));
        return completion("seen");
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "nylorun-gate-files-"));
    try {
      const blobs = createFsBlobStore({ root });
      const server = await gate({ blobs });
      const sessionA = await running();
      const sessionB = await running();
      // One image artifact in each session, as an upload would leave it.
      const artifactOf = async (sessionId: string, bytes: Uint8Array) => {
        const id = newArtifactId();
        const stored = await blobs.put(`artifacts/${id}/v1`, bytes, { contentType: "image/png" });
        const now = new Date().toISOString();
        await runs.store.tx((t) =>
          t.insertArtifact(
            {
              id,
              kind: "file",
              name: "image.png",
              contentType: "image/png",
              sessionId,
              latestVersion: 1,
              labelsJson: null,
              createdAt: now,
              updatedAt: now,
            },
            {
              artifactId: id,
              version: 1,
              blobKey: stored.key,
              size: stored.size,
              sha256: stored.sha256,
              contentType: "image/png",
              source: "upload",
              createdAt: now,
            },
          ),
        );
        return id;
      };
      const mine = await artifactOf(sessionA.claims.sessionId, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]));
      const theirs = await artifactOf(sessionB.claims.sessionId, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 2]));
      const naming = (artifactId: string, effectId: string) => ({
        ...body,
        effectId,
        call: {
          ...body.call,
          prompt: [
            {
              kind: "message",
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "media", mediaType: "image/png", reference: { artifactId, version: 1 } },
              ],
            },
          ],
        },
      });

      // Session A's token naming session B's artifact: refused, and the provider never called.
      const refused = await post(server, sessionA, {
        body: naming(theirs, "turn-1:0:model:theirs"),
        keyed: false,
      });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({
        outcome: { kind: "failed", code: "invalid_request" },
      });
      expect(providerBodies).toEqual([]);

      // Its own artifact reaches the provider as image input.
      const served = await post(server, sessionA, {
        body: naming(mine, "turn-1:0:model:mine"),
        keyed: false,
      });
      expect(await served.json()).toMatchObject({ outcome: { output: [{ type: "text", text: "seen" }] } });
      expect(providerBodies).toHaveLength(1);
      expect(providerBodies[0]).toContain(
        `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64")}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves a call that names no Tenant: the run token names it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion("unnamed")));
    const server = await gate();
    const grant = await running();
    const response = await realFetch(`${server.url}${MODEL_CALLS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "idempotency-key": body.effectId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: { output: [{ type: "text", text: "unnamed" }] },
    });
    expect(logs).toContainEqual({
      message: "model_call",
      fields: expect.objectContaining({ tenant: tenantId, outcome: "ok" }),
    });
  });

  it("scopes the ledger by the token's agent; a body that names a scope is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completion("metered", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })),
    );
    const server = await gate();
    const grant = await running({ agentId: "capped" });
    for (const named of [{ agentId: "uncapped" }, { sessionId: "session-x" }, { turnId: "turn-x" }]) {
      const refused = await post(server, grant, { body: { ...body, ...named } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect((await post(server, grant)).status).toBe(200);
    const spent = (agentId: string) =>
      runs.store.tx((t) => t.modelUsageTotals({ scope: "agent", id: agentId }));
    expect((await spent("capped")).calls).toBe(1);
    expect((await spent("uncapped")).calls).toBe(0);
    expect((await runs.store.tx((t) => t.modelUsageTotals({ scope: "turn", id: "turn-1" }))).calls).toBeGreaterThan(0);
  });

  describe("credentials (F5)", () => {
    it("refuses a model call with no credential, core's credential or a bad token: 401 gate_unauthorized", async () => {
      const provider = vi.fn();
      vi.stubGlobal("fetch", provider);
      const server = await gate();
      const grant = await running();
      const [header, payload] = grant.token.split(".");
      const forged = `${header}.${payload}.${"A".repeat(86)}`;
      for (const authorization of ["", `Bearer ${token}`, `Bearer ${"ef".repeat(32)}`, `Bearer ${forged}`, "Bearer a.b.c"]) {
        const response = await post(server, undefined, { headers: { authorization } });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: "gate_unauthorized" } });
      }
      expect(provider).not.toHaveBeenCalled();
    });

    it("refuses another Tenant's run token", async () => {
      const server = await gate();
      const other = await runFixture();
      const foreign = await other.run("session-foreign");
      const response = await post(server, foreign, { headers: { "nylorun-tenant": other.tenantId } });
      expect(response.status).toBe(401);
      const unnamed = await post(server, foreign, { headers: { "nylorun-tenant": tenantId } });
      expect(unnamed.status).toBe(401);
    });

    it("refuses a Tenant header that is not the token's", async () => {
      const server = await gate();
      const grant = await running();
      const response = await post(server, grant, { headers: { "nylorun-tenant": newTenantId() } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    });

    it("refuses a run token on the keys and deliveries routes", async () => {
      const server = await gate();
      const grant = await running();
      for (const path of [`${KEYS_PATH}/sign`, DELIVERIES_PATH]) {
        const response = await realFetch(`${server.url}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
          body: JSON.stringify(
            path === DELIVERIES_PATH
              ? { url: "http://127.0.0.1:9/x", body: "{}", headers: {}, timeoutMs: 1_000 }
              : { args: [{ typ: "nylorun-run+jwt", claims: {} }] },
          ),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: "gate_unauthorized" } });
      }
      // Core's credential still reaches the keys.
      const keys = await realFetch(`${server.url}${KEYS_PATH}/ensureSigningKeys`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      expect(keys.status).toBe(200);
    });

    it("answers 409 run_stale after a cancel, a new turn or a takeover", async () => {
      const provider = vi.fn(async () => completion("late"));
      vi.stubGlobal("fetch", provider);
      const server = await gate();
      const cancelled = await running();
      await runs.update(cancelled.claims.sessionId, { status: "cancelled", activeTurnId: null });
      const newTurn = await running();
      await runs.update(newTurn.claims.sessionId, { activeTurnId: "turn-2" });
      const takenOver = await running();
      await runs.takeOver(takenOver.claims.sessionId);
      for (const grant of [cancelled, newTurn, takenOver]) {
        const response = await post(server, grant);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "run_stale" } });
      }
      expect(provider).not.toHaveBeenCalled();
      expect(logs).toContainEqual({ message: "gate_run_stale", fields: expect.objectContaining({ session: takenOver.claims.sessionId }) });
    });
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
    const grant = await running();
    const cases: [Parameters<typeof post>[2], RegExp][] = [
      [{ headers: { "nylorun-tenant": "../../etc" } }, /must name a Tenant/],
      [{ body: "{not json" }, /must be JSON/],
      [{ body: { ...body, call: { tools: [] } } }, /Invalid model call/],
      [{ body: { ...body, padding: "x".repeat(4096) } }, /at most 2048 bytes/],
    ];
    for (const [init, message] of cases) {
      const response = await post(server, grant, init);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(message);
    }
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
    const grant = await running();
    const caller = new AbortController();
    const pending = post(server, grant, { signal: caller.signal, keyed: false }).catch(() => undefined);
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
      const grant = await running();
      const caller = new AbortController();
      const first = post(server, grant, { signal: caller.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      caller.abort();
      await first;
      expect(provider.upstream()?.aborted).toBe(false);
      provider.release();
      const resent = await post(server, grant);
      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({
        outcome: { output: [{ type: "text", text: "survived" }] },
      });
      expect(provider.calls()).toBe(1);
    });

    it("joins a call still running when the same request is re-sent", async () => {
      const provider = heldProvider();
      const server = await gate();
      const grant = await running();
      const first = post(server, grant);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const second = post(server, grant);
      provider.release();
      expect((await (await first).json()).outcome.output[0].text).toBe("survived");
      expect((await (await second).json()).outcome.output[0].text).toBe("survived");
      expect(provider.calls()).toBe(1);
    });

    it("lets the new owner join after a takeover; the old owner's re-send is stale", async () => {
      const provider = heldProvider();
      const server = await gate();
      const old = await running();
      const first = post(server, old).catch(() => undefined);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const owner = await runs.takeOver(old.claims.sessionId);
      expect(owner.claims.epoch).toBeGreaterThan(old.claims.epoch);
      const stale = await post(server, old);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "run_stale" } });
      const joined = post(server, owner);
      provider.release();
      expect((await (await joined).json()).outcome.output[0].text).toBe("survived");
      await first;
      expect(provider.calls()).toBe(1);
    });

    it("never joins another session's call under the same key", async () => {
      const provider = heldProvider();
      const server = await gate();
      const mine = await running();
      const theirs = await running();
      const first = post(server, mine);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const other = await post(server, theirs);
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({ error: { code: "gate_conflict" } });
      provider.release();
      await first;
      expect(provider.calls()).toBe(1);
    });

    it("answers 409 gate_conflict to a different request under the same key", async () => {
      const provider = heldProvider();
      const server = await gate();
      const grant = await running();
      const first = post(server, grant);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      const changed = await post(server, grant, { body: { ...body, invocationId: "2" } });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "gate_conflict" } });
      provider.release();
      await first;
    });

    it("cancels a keyed call by effect id with its session's token, even once the run is stale", async () => {
      const provider = heldProvider();
      const server = await gate();
      const grant = await running();
      const other = await running();
      const first = post(server, grant).catch(() => undefined);
      await vi.waitFor(() => expect(provider.calls()).toBe(1));
      // Another session's token, and core's credential, cannot cancel it.
      const forbidden = await cancel(server, other.token);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: { code: "gate_forbidden" } });
      expect((await cancel(server, token)).status).toBe(401);
      expect((await cancel(server, undefined)).status).toBe(401);
      expect(provider.upstream()?.aborted).toBe(false);
      // A user cancel makes the run stale; its cancel still stops the call.
      await runs.update(grant.claims.sessionId, { status: "cancelled", activeTurnId: null });
      const cancelled = await cancel(server, grant.token);
      expect(cancelled.status).toBe(204);
      await vi.waitFor(() => expect(provider.upstream()?.aborted).toBe(true));
      await first;
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
