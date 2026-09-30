import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import {
  HOST_PROTOCOL,
  hashManifest,
  OUTCOME_HEADER,
  SIGNATURE_HEADER,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { DELIVERY_TOKEN_TYPE, subjectTokenIssuer } from "@nylorun/core/contracts";
import { createActionHandler } from "../src/action-handler.js";
import { AgentsClient } from "../src/client.js";
import { bodyHash } from "../src/delivery-token.js";
import { IncompatibleRuntimeError } from "../src/http.js";

const TENANT = "tn_00000000000000000000000001";
const RUNTIME = "http://127.0.0.1:8787";
const ENDPOINT = "http://localhost:3000/nylorun/actions";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "key_1",
  alg: "ES256",
  use: "sig",
};

const b64 = (value: string | ArrayBuffer) =>
  Buffer.from(typeof value === "string" ? value : new Uint8Array(value)).toString("base64url");

async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  key: CryptoKey = pair.privateKey,
): Promise<string> {
  const h = b64(JSON.stringify({ alg: "ES256", typ: DELIVERY_TOKEN_TYPE, kid: "key_1", ...header }));
  const p = b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64(signature)}`;
}

const seen: { input: unknown; aborted: boolean }[] = [];
const lookup = tool({
  name: "lookup",
  input: z.object({ q: z.string() }),
  run: async ({ q }, ctx) => {
    seen.push({ input: q, aborted: ctx.signal.aborted });
    if (q === "boom") throw new Error("lookup failed");
    if (q === "ask") return (await ctx.approve("Look it up?")) ? "approved" : "denied";
    if (q === "sandbox") return (ctx as { sandbox?: any }).sandbox.bash({ command: "ls" });
    return `found ${q}`;
  },
});
const support = Agent({ id: "support", tools: [lookup] }).build();

function action(input: unknown, overrides: Record<string, unknown> = {}) {
  return {
    actionId: "a1",
    sessionId: "s1",
    turnId: "t1",
    agentId: "support",
    manifestHash: "h",
    implementationVersion: "dev",
    input,
    context: {},
    status: "delivering",
    generation: 1,
    deadlineAt: "2026-09-30T12:01:00.000Z",
    kind: "tool",
    capabilityId: "agent",
    toolName: "lookup",
    ...overrides,
  };
}

async function delivery(
  body: unknown,
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    key?: CryptoKey;
    signature?: string | null;
    rawBody?: string;
  } = {},
): Promise<Request> {
  const text = options.rawBody ?? JSON.stringify(body);
  const parsed = body as { type: string; action?: { actionId: string; generation: number; agentId: string }; agentId?: string };
  const now = Math.floor(Date.now() / 1000);
  const token =
    options.signature === undefined
      ? await sign(
          {
            iss: subjectTokenIssuer(TENANT),
            aud: ENDPOINT,
            sub: parsed.type === "ping" ? "ping" : parsed.action?.actionId,
            agt: parsed.type === "ping" ? parsed.agentId : parsed.action?.agentId,
            gen: parsed.type === "ping" ? 0 : parsed.action?.generation,
            bdy: await bodyHash(new TextEncoder().encode(JSON.stringify(body))),
            iat: now,
            exp: now + 60,
            jti: "j1",
            ...options.claims,
          },
          options.header,
          options.key,
        )
      : options.signature;
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { [SIGNATURE_HEADER]: token }),
    },
    body: text,
  });
}

/** A handler that reads the Tenant's keys with the Tenant header only, recording each request. */
function handler(extra: Record<string, unknown> = {}) {
  const requests: { url: string; headers: Headers; body?: unknown }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/v1/access/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/health"))
      return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL } });
    if (url.includes("/sandbox/"))
      return Response.json({ kind: "completed", output: "listing" });
    throw new Error(`unexpected ${url}`);
  };
  const actions = createActionHandler({
    agents: [support],
    runtime: { url: RUNTIME, tenant: TENANT, fetch },
    url: ENDPOINT,
    ...extra,
  });
  return { actions, requests };
}

describe("createActionHandler: deliveries", () => {
  it("runs a tool and answers with the tagged outcome", async () => {
    const { actions, requests } = handler();
    const response = await actions.fetch(
      await delivery({ type: "action", action: action({ q: "cats" }), sandbox: false }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(OUTCOME_HEADER)).toBe("1");
    expect(await response.json()).toEqual({
      value: { kind: "completed", output: "found cats" },
      statePatch: {},
    });
    // The keys were read with the Tenant header and no credential.
    const jwks = requests.find((r) => r.url.endsWith("/v1/access/jwks"))!;
    expect(jwks.headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(jwks.headers.has("authorization")).toBe(false);
  });

  it("answers tool errors and approvals as outcomes", async () => {
    const { actions } = handler();
    const failed = await actions.fetch(
      await delivery({ type: "action", action: action({ q: "boom" }), sandbox: false }),
    );
    expect(failed.status).toBe(200);
    expect((await failed.json()).value).toMatchObject({
      kind: "failed",
      code: "tool.execution-failed",
      message: "lookup failed",
    });
    const paused = await actions.fetch(
      await delivery({ type: "action", action: action({ q: "ask" }), sandbox: false }),
    );
    expect((await paused.json()).value).toMatchObject({
      kind: "interaction-required",
      interaction: { kind: "approval", prompt: "Look it up?" },
    });
  });

  it("gives the tool a sandbox that calls back with the delivery token", async () => {
    const { actions, requests } = handler();
    const request = await delivery({ type: "action", action: action({ q: "sandbox" }), sandbox: true });
    const token = request.headers.get(SIGNATURE_HEADER);
    const response = await actions.fetch(request);
    // The sandbox's own result is a tagged outcome, which the tool's result passes through.
    expect((await response.json()).value).toEqual({ kind: "completed", output: "listing" });
    const call = requests.find((r) => r.url.includes("/sandbox/"))!;
    expect(call.url).toBe(`${RUNTIME}/v1/actions/a1/sandbox/bash`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(call.body).toEqual({ command: "ls" });
  });

  it("checks the Runtime once for every sandbox, each call with its own delivery's token", async () => {
    const { actions, requests } = handler();
    const tokens: (string | null)[] = [];
    for (const actionId of ["a1", "a2"]) {
      const request = await delivery({
        type: "action",
        action: action({ q: "sandbox" }, { actionId }),
        sandbox: true,
      });
      tokens.push(request.headers.get(SIGNATURE_HEADER));
      expect((await actions.fetch(request)).status).toBe(200);
    }
    expect(requests.filter((r) => r.url.endsWith("/health"))).toHaveLength(1);
    const calls = requests.filter((r) => r.url.includes("/sandbox/"));
    expect(calls.map((c) => c.url)).toEqual([
      `${RUNTIME}/v1/actions/a1/sandbox/bash`,
      `${RUNTIME}/v1/actions/a2/sandbox/bash`,
    ]);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(
      tokens.map((token) => `Bearer ${token}`),
    );
  });

  it("refuses a request without a valid token for exactly this delivery", async () => {
    const { actions } = handler();
    const body = { type: "action", action: action({ q: "cats" }), sandbox: false };
    const cases: [string, Promise<Request>, string][] = [
      ["no token", delivery(body, { signature: null }), "signature_missing"],
      ["another key", delivery(body, { key: other.privateKey }), "signature_invalid"],
      ["another type", delivery(body, { header: { typ: "nylorun-subject+jwt" } }), "signature_invalid"],
      ["embedded key", delivery(body, { header: { jwk } }), "signature_invalid"],
      ["another Tenant", delivery(body, { claims: { iss: subjectTokenIssuer("tn_x") } }), "signature_invalid"],
      ["another URL", delivery(body, { claims: { aud: "https://evil.example/actions" } }), "signature_invalid"],
      ["another Action", delivery(body, { claims: { sub: "a2" } }), "signature_invalid"],
      ["another generation", delivery(body, { claims: { gen: 2 } }), "signature_invalid"],
      ["another agent", delivery(body, { claims: { agt: "triage" } }), "signature_invalid"],
      ["changed body", delivery(body, { rawBody: JSON.stringify({ ...body, sandbox: true }) }), "signature_invalid"],
      ["expired", delivery(body, { claims: { exp: Math.floor(Date.now() / 1000) - 120 } }), "token_expired"],
      ["garbage", delivery(body, { signature: "not.a.jwt" }), "signature_invalid"],
    ];
    for (const [name, request, code] of cases) {
      const response = await actions.fetch(await request);
      expect(response.status, name).toBe(401);
      expect((await response.json()).code, name).toBe(code);
    }
    expect(seen.filter((s) => s.input === "cats")).toHaveLength(1);
  });

  it("answers an unknown key with a retryable 503, refetching at most once per interval", async () => {
    const { actions, requests } = handler();
    const body = { type: "action", action: action({ q: "cats" }), sandbox: false };
    for (let i = 0; i < 3; i++) {
      const response = await actions.fetch(await delivery(body, { header: { kid: `key_${i + 5}` } }));
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("key_unknown");
    }
    expect(requests.filter((r) => r.url.endsWith("/v1/access/jwks"))).toHaveLength(1);
  });

  it("uses public keys given in the options without reading them", async () => {
    const { actions, requests } = handler({ jwks: { keys: [jwk] } });
    const response = await actions.fetch(
      await delivery({ type: "action", action: action({ q: "dogs" }), sandbox: false }),
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(0);
  });

  it("answers 404 for an agent or tool it does not serve, and 405 and 400 for bad requests", async () => {
    const { actions } = handler();
    const unknownAgent = { type: "action", action: action({ q: "x" }, { agentId: "triage" }), sandbox: false };
    const agent = await actions.fetch(await delivery(unknownAgent));
    expect(agent.status).toBe(404);
    expect((await agent.json()).code).toBe("agent_not_served");
    const unknownTool = { type: "action", action: action({ q: "x" }, { toolName: "nope" }), sandbox: false };
    const toolResponse = await actions.fetch(await delivery(unknownTool));
    expect(toolResponse.status).toBe(404);
    expect((await toolResponse.json()).code).toBe("action_not_served");
    expect((await actions.fetch(new Request(ENDPOINT))).status).toBe(405);
    const notDelivery = await actions.fetch(await delivery({ type: "claim" } as never, { claims: { sub: "ping", agt: "support", gen: 0 } }));
    expect(notDelivery.status).toBe(400);
  });

  it("answers a ping for a served agent", async () => {
    const { actions } = handler({ implementationVersion: "v7" });
    const ping = await actions.fetch(await delivery({ type: "ping", agentId: "support" }));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ agentId: "support", implementationVersion: "v7" });
    const unknown = await actions.fetch(await delivery({ type: "ping", agentId: "triage" }));
    expect(unknown.status).toBe(404);
  });

  it("runs flow actions only for the flow manifest it serves", async () => {
    const shout = tool({
      name: "shout",
      input: z.object({ word: z.string() }),
      run: async ({ word }) => word.toUpperCase(),
    });
    const desk = Agent({ id: "desk" })
      .step(Agent({ id: "writer" }).instructions("Write."))
      .step(shout, { input: ({ input }) => ({ word: String(input) }) })
      .build();
    const { actions } = handler({ agents: [desk] });
    const flowAction = (manifestHash: string) =>
      action(
        { input: "hi", results: {}, flowInput: "go" },
        { agentId: "desk", manifestHash, kind: "fn", path: "shout:input", key: "shout:input", capabilityId: undefined, toolName: undefined },
      );
    const stale = await actions.fetch(
      await delivery({ type: "action", action: flowAction("sha256:old"), sandbox: false }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "version_mismatch" });
    const current = await actions.fetch(
      await delivery({ type: "action", action: flowAction(hashManifest(desk.manifest)), sandbox: false }),
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ value: { word: "hi" } });
  });

  it("serves node:http through the same handler", async () => {
    const { createServer } = await import("node:http");
    const { actions } = handler();
    const server = createServer(actions.node);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const request = await delivery({ type: "action", action: action({ q: "node" }), sandbox: false });
      const response = await fetch(`http://127.0.0.1:${port}/nylorun/actions`, {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).value).toEqual({ kind: "completed", output: "found node" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("createActionHandler: register", () => {
  function application(features: readonly string[]) {
    const calls: { method: string; path: string; body?: any }[] = [];
    const client = new AgentsClient({
      url: RUNTIME,
      tenant: TENANT,
      key: "a".repeat(64),
      fetch: async (input, init) => {
        const path = String(input).slice(RUNTIME.length);
        calls.push({
          method: init?.method ?? "GET",
          path,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (path === "/health")
          return Response.json({
            status: "ok",
            protocol: {
              ...HOST_PROTOCOL,
              features: [
                ...HOST_PROTOCOL.features.filter((f) => f !== "action-endpoints"),
                ...features,
              ],
            },
          });
        if (path.startsWith("/v1/agents/")) return Response.json({ ok: true });
        if (path === "/v1/endpoints") return Response.json({ endpoints: [] });
        if (path.endsWith("/ping"))
          return Response.json({ agentId: "support", implementationVersion: "v7" });
        throw new Error(`unexpected ${path}`);
      },
    });
    return { client, calls };
  }

  it("saves the definitions, registers the URL and pings each agent", async () => {
    const { client, calls } = application(["action-endpoints"]);
    const actions = createActionHandler({ agents: [support], client, implementationVersion: "v7" });
    const answers = await actions.register({ url: ENDPOINT, timeoutMs: 30_000 });
    expect(answers).toEqual([{ agentId: "support", implementationVersion: "v7" }]);
    expect(calls.filter((c) => c.path !== "/health").map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /v1/agents/support",
      "PUT /v1/endpoints",
      "POST /v1/endpoints/support/ping",
    ]);
    expect(calls.find((c) => c.path === "/v1/endpoints")!.body).toEqual({
      endpoints: [
        { agentId: "support", url: ENDPOINT, implementationVersion: "v7", timeoutMs: 30_000 },
      ],
    });
  });

  it("can skip saving definitions", async () => {
    const { client, calls } = application(["action-endpoints"]);
    await createActionHandler({ agents: [support], client }).register({
      url: ENDPOINT,
      saveDefinitions: false,
    });
    expect(calls.some((c) => c.path.startsWith("/v1/agents/"))).toBe(false);
  });

  it("refuses a Runtime without Action endpoints before sending anything", async () => {
    const { client, calls } = application([]);
    await expect(
      createActionHandler({ agents: [support], client }).register({ url: ENDPOINT }),
    ).rejects.toBeInstanceOf(IncompatibleRuntimeError);
    expect(calls.map((c) => c.path)).toEqual(["/health"]);
  });

  it("then requires every token to name the registered URL", async () => {
    const { client } = application(["action-endpoints"]);
    const jwksFetch = async () => Response.json({ keys: [jwk] });
    const actions = createActionHandler({
      agents: [support],
      client,
      runtime: { url: RUNTIME, tenant: TENANT, fetch: jwksFetch },
    });
    const body = { type: "action", action: action({ q: "url" }), sandbox: false };
    const elsewhere = { claims: { aud: "https://other.example/actions" } };
    // Before registering, the handler does not know its URL.
    expect((await actions.fetch(await delivery(body, elsewhere))).status).toBe(200);
    await actions.register({ url: ENDPOINT, saveDefinitions: false });
    expect((await actions.fetch(await delivery(body, elsewhere))).status).toBe(401);
    expect((await actions.fetch(await delivery(body))).status).toBe(200);
  });
});

describe("createActionHandler: background tools", () => {
  function backgroundHandler(heartbeat: (n: number) => Response) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const seen = { aborted: false, finished: false };
    const slow = tool({
      name: "slow",
      input: z.object({ q: z.string() }),
      background: true,
      run: async ({ q }, ctx) => {
        await Promise.race([
          released,
          new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        seen.aborted = ctx.signal.aborted;
        seen.finished = true;
        return `slow ${q}`;
      },
    });
    const worker = Agent({ id: "worker", tools: [slow] }).build();
    const calls: { path: string; auth: string | null; body?: unknown }[] = [];
    let beats = 0;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.startsWith(RUNTIME) ? url.slice(RUNTIME.length) : url;
      const headers = new Headers(init?.headers);
      if (path === "/v1/access/jwks") return Response.json({ keys: [jwk] });
      if (path === "/health") return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL } });
      calls.push({ path, auth: headers.get("authorization"), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.endsWith("/heartbeat")) {
        beats += 1;
        const answer = heartbeat(beats);
        if (answer.status !== 200) settle();
        return answer;
      }
      if (path.endsWith("/result")) {
        settle();
        return Response.json({ status: "accepted", turnId: "t1", cursor: "c" });
      }
      throw new Error(`unexpected ${path}`);
    };
    const works: Promise<unknown>[] = [];
    const actions = createActionHandler({
      agents: [worker],
      runtime: { url: RUNTIME, tenant: TENANT, fetch },
      url: ENDPOINT,
      waitUntil: (work) => works.push(work),
    });
    const deliveryOf = () =>
      delivery({
        type: "action",
        action: action({ q: "x" }, { agentId: "worker", toolName: "slow" }),
        sandbox: false,
      });
    return { actions, calls, release, settled, seen, works, deliveryOf };
  }

  it("answers 202 at once, heartbeats with the newest token, and posts the result", async () => {
    const t = backgroundHandler((n) =>
      Response.json({ token: `token-${n}`, deadlineAt: new Date(Date.now() + 3_000).toISOString() }),
    );
    const request = await t.deliveryOf();
    const first = request.headers.get(SIGNATURE_HEADER);
    const response = await t.actions.fetch(request);
    expect(response.status).toBe(202);
    expect(t.works).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    t.release();
    await t.settled;
    await t.works[0];
    expect(t.calls.map((c) => c.path)).toEqual(["/v1/actions/a1/heartbeat", "/v1/actions/a1/result"]);
    expect(t.calls[0]!.auth).toBe(`Bearer ${first}`);
    expect(t.calls[1]).toMatchObject({
      auth: "Bearer token-1",
      body: { value: { kind: "completed", output: "slow x" } },
    });
    expect(t.seen).toEqual({ aborted: false, finished: true });
  });

  it("stops the tool and posts nothing when a heartbeat says the delivery is over", async () => {
    const t = backgroundHandler(() => Response.json({ status: "rejected", message: "cancelled" }, { status: 409 }));
    expect((await t.actions.fetch(await t.deliveryOf())).status).toBe(202);
    await t.settled;
    await t.works[0];
    expect(t.seen).toEqual({ aborted: true, finished: true });
    expect(t.calls.map((c) => c.path)).toEqual(["/v1/actions/a1/heartbeat"]);
  });
});
