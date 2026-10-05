/**
 * The Action deliverer (design: Action endpoints §5, §6): a turn's tool call is POSTed to the
 * agent's Action endpoint, signed, and the answer settles it. The endpoint here is a plain
 * `node:http` server whose answers each test scripts; the last case serves the agent with the
 * SDK's `createActionHandler`.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { OUTCOME_HEADER, SIGNATURE_HEADER } from "@nylorun/core/compatibility";
import type { Action } from "@nylorun/core/contracts";
import { AgentsClient, createActionHandler } from "@nylorun/agents";
import { interpret } from "../src/tenant/delivery.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close().catch(() => {});
});

const saves: unknown[] = [];
const agent = Agent({ id: "issue", name: "Issue" })
  .use({
    id: "notes",
    tools: [
      tool({
        name: "save",
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        async run(input) {
          saves.push(input);
          return { saved: true as const };
        },
      }),
    ],
  })
  .build();

interface Received {
  request: IncomingMessage;
  body: string;
}
type Answer = { status: number; headers?: Record<string, string>; body?: unknown } | "hang";

/** A local endpoint: answers each request with the next scripted answer (the last one repeats). */
async function endpoint(answers: Answer[], port = 0) {
  const received: Received[] = [];
  const closed: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ request, body });
      const answer = answers[Math.min(received.length - 1, answers.length - 1)]!;
      response.on("close", () => {
        if (!response.writableFinished) closed.push(body);
      });
      if (answer === "hang") return;
      response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  });
  await listen(server, port);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/actions`, port: address.port, received, closed, server };
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

async function tenant() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result")
        return { output: [{ type: "text", text: "done" }] };
      return { output: [{ type: "tool-call", id: "call-1", name: "save", args: { note: "hi" } }] };
    },
  });
  cleanup.push(() => runtime.close());
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  expect(
    (await api("PUT", "/v1/agents/issue", { requestId: "put", manifest: agent.manifest, implementationVersion: "dev" }))
      .status,
  ).toBe(200);
  return { runtime, api };
}

type Api = Awaited<ReturnType<typeof tenant>>["api"];

async function start(api: Api, url: string, timeoutMs = 5_000) {
  expect(
    (await api("PUT", "/v1/endpoints", {
      endpoints: [{ agentId: "issue", url, implementationVersion: "dev", timeoutMs }],
    })).status,
  ).toBe(200);
  await api("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "issue", ownerUserId: "user" });
  const sent = await api("POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "save a note",
  });
  expect(sent.status).toBe(200);
}

async function events(api: Api) {
  const items = (await api("GET", "/v1/sessions/s1/items")).body as {
    items: { type: string; payload: any }[];
  };
  return items.items;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const status = (api: Api) => async () => ((await api("GET", "/v1/sessions/s1")).body as { status: string }).status;
const tagged = (value: unknown) => ({ status: 200, headers: { [OUTCOME_HEADER]: "1" }, body: { value } });

describe("delivering a tool call", () => {
  it("POSTs the Action signed for this delivery and records a tagged outcome", async () => {
    const { api } = await tenant();
    const target = await endpoint([tagged({ kind: "completed", output: { saved: true } })]);
    await start(api, target.url);
    await until(status(api), (s) => s === "idle" || s === "completed");
    expect(target.received).toHaveLength(1);
    const [{ request, body }] = target.received;
    const delivery = JSON.parse(body) as { type: string; action: Action; sandbox: boolean };
    expect(delivery).toMatchObject({
      type: "action",
      sandbox: false,
      action: { kind: "tool", toolName: "save", input: { note: "hi" }, status: "delivering", generation: 1 },
    });
    expect(request.headers["idempotency-key"]).toBe(delivery.action.actionId);
    const token = String(request.headers[SIGNATURE_HEADER.toLowerCase()]);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({
      aud: target.url,
      sub: delivery.action.actionId,
      agt: "issue",
      gen: 1,
      bdy: createHash("sha256").update(body).digest("base64url"),
    });
    const types = (await events(api)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["action.pending", "action.delivered", "action.completed"]));
    const completed = (await events(api)).find((e) => e.type === "action.completed")!;
    expect(completed.payload.result).toEqual({ kind: "completed", output: { saved: true } });
    const listed = (await api("GET", "/v1/endpoints")).body.endpoints[0];
    expect(listed.health).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: expect.any(String) });
  });

  it("takes a plain answer as the tool's output, and checks it against the output schema", async () => {
    const { api } = await tenant();
    const target = await endpoint([{ status: 200, body: { saved: false } }]);
    await start(api, target.url);
    await until(status(api), (s) => s === "idle" || s === "completed");
    const completed = (await events(api)).find((e) => e.type === "action.completed")!;
    expect(completed.payload.result).toMatchObject({ kind: "failed", code: "tool.invalid-output" });
  });

  it("retries a busy endpoint after Retry-After, reporting the failure once", async () => {
    const { api } = await tenant();
    const target = await endpoint([
      { status: 429, headers: { "retry-after": "0.2" }, body: { message: "slow down" } },
      tagged({ kind: "completed", output: { saved: true } }),
    ]);
    await start(api, target.url);
    await until(status(api), (s) => s === "idle" || s === "completed");
    expect(target.received).toHaveLength(2);
    const failed = (await events(api)).filter((e) => e.type === "action.delivery_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ reason: "endpoint.busy", message: "slow down", generation: 1 });
    const generations = target.received.map((r) => JSON.parse(r.body).action.generation);
    expect(generations).toEqual([1, 2]);
  });

  it("waits for an endpoint that is down, and delivers once it is up", async () => {
    const { api } = await tenant();
    const probe = await endpoint([]);
    const port = probe.port;
    await new Promise((resolve) => probe.server.close(resolve));
    await start(api, `http://127.0.0.1:${port}/actions`);
    await until(
      () => events(api),
      (items) => items.some((e) => e.type === "action.delivery_failed"),
    );
    const failure = (await api("GET", "/v1/endpoints")).body.endpoints[0].health;
    expect(failure).toMatchObject({ lastError: { code: "endpoint.unreachable" } });
    expect(failure.consecutiveFailures).toBeGreaterThan(0);
    const target = await endpoint([tagged({ kind: "completed", output: { saved: true } })], port);
    await until(status(api), (s) => s === "idle" || s === "completed", 20_000);
    expect(target.received).toHaveLength(1);
  });

  it("fails the tool when the endpoint refuses the delivery", async () => {
    const { api } = await tenant();
    const target = await endpoint([{ status: 404, body: { code: "agent_not_served", message: "This endpoint does not serve 'issue'" } }]);
    await start(api, target.url);
    await until(status(api), (s) => s === "idle" || s === "completed");
    const completed = (await events(api)).find((e) => e.type === "action.completed")!;
    expect(completed.payload.result).toEqual({
      kind: "failed",
      code: "endpoint.rejected",
      message: "This endpoint does not serve 'issue'",
    });
  });

  it("makes the tool uncertain when a delivery times out after it was sent", async () => {
    const { api } = await tenant();
    const target = await endpoint(["hang"]);
    await start(api, target.url, 1_000);
    await until(status(api), (s) => s === "uncertain");
    expect((await events(api)).map((e) => e.type)).toContain("action.uncertain");
    expect(target.received).toHaveLength(1);
  });

  it("aborts the request when the turn is cancelled", async () => {
    const { api } = await tenant();
    const target = await endpoint(["hang"]);
    await start(api, target.url, 30_000);
    await until(async () => target.received.length, (n) => n === 1);
    await api("POST", "/v1/sessions/s1/commands", { type: "cancel", requestId: "c1", idempotencyKey: "c1" });
    await until(async () => target.closed.length, (n) => n === 1);
    expect(await status(api)()).toBe("cancelled");
  });
});

describe("pinging an endpoint", () => {
  it("records what the endpoint serves, and answers 502 when it does not answer", async () => {
    const { api } = await tenant();
    const target = await endpoint([{ status: 200, body: { agentId: "issue", implementationVersion: "v7", manifestHash: "h" } }]);
    await api("PUT", "/v1/endpoints", { endpoints: [{ agentId: "issue", url: target.url, implementationVersion: "dev" }] });
    const ping = await api("POST", "/v1/endpoints/issue/ping");
    expect(ping).toEqual({ status: 200, body: { agentId: "issue", implementationVersion: "v7", manifestHash: "h" } });
    expect(JSON.parse(target.received[0]!.body)).toEqual({ type: "ping", agentId: "issue" });
    expect((await api("GET", "/v1/endpoints")).body.endpoints[0].health.served).toEqual({
      implementationVersion: "v7",
      manifestHash: "h",
    });
    await new Promise((resolve) => target.server.close(resolve));
    const down = await api("POST", "/v1/endpoints/issue/ping");
    expect(down.status).toBe(502);
    expect((await api("POST", "/v1/endpoints/ghost/ping")).status).toBe(404);
  });
});

describe("the SDK handler as the endpoint", () => {
  it("runs the tool's own code and completes the turn", async () => {
    const { runtime, api } = await tenant();
    const server = createServer();
    await listen(server, 0);
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/actions`;
    const actions = createActionHandler({
      agents: [agent],
      client: new AgentsClient({ url: runtime.url, tenant: runtime.tenantId, key: APP }),
      url,
    });
    server.on("request", actions.node);
    saves.length = 0;
    await start(api, url);
    await until(status(api), (s) => s === "idle" || s === "completed");
    expect(saves).toEqual([{ note: "hi" }]);
    const completed = (await events(api)).find((e) => e.type === "action.completed")!;
    expect(completed.payload.result).toEqual({ kind: "completed", output: { saved: true } });
  });
});

describe("reading an answer", () => {
  const action = (kind: string) => ({ kind }) as unknown as Action;
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    kind: "response" as const,
    status,
    headers,
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  });

  it("maps every answer the design names", () => {
    expect(interpret(action("tool"), response(200, { a: 1 }))).toEqual({
      kind: "outcome",
      outcome: { value: { kind: "completed", output: { a: 1 } } },
    });
    expect(
      interpret(action("tool"), response(200, { value: { kind: "denied", reason: "no" } }, { "nylorun-outcome": "1" }))
    ).toEqual({ kind: "outcome", outcome: { value: { kind: "denied", reason: "no" } } });
    expect(interpret(action("tool"), response(202, ""))).toEqual({ kind: "accepted" });
    expect(interpret(action("tool"), response(503, "", { "retry-after": "2" }))).toMatchObject({ kind: "retry", retryAfterMs: 2000 });
    expect(interpret(action("tool"), response(409, { message: "v2 here" }))).toMatchObject({ kind: "retry", code: "endpoint.version-mismatch", message: "v2 here" });
    expect(interpret(action("tool"), response(500, "boom"))).toMatchObject({ kind: "lost", code: "endpoint.failed" });
    expect(interpret(action("tool"), response(302, ""))).toMatchObject({ outcome: { value: { code: "endpoint.rejected" } } });
    expect(interpret(action("tool"), response(200, "not json"))).toMatchObject({ outcome: { value: { code: "endpoint.invalid-answer" } } });
    expect(interpret(action("tool"), { kind: "not_sent", code: "ECONNREFUSED", message: "refused" })).toMatchObject({ kind: "retry" });
    expect(interpret(action("tool"), { kind: "lost", code: "ECONNRESET", message: "reset" })).toMatchObject({ kind: "lost" });
    expect(interpret(action("tool"), { kind: "too_large", status: 200 })).toMatchObject({ outcome: { value: { code: "endpoint.answer-too-large" } } });
  });
});
