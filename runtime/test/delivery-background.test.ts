/**
 * Background outcomes (design: Action endpoints §5.4): an endpoint answers a delivery with
 * `202`, heartbeats with the delivery token, may use the session's sandbox, and posts the
 * outcome later.
 */
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { SIGNATURE_HEADER } from "@nylorun/core/compatibility";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close().catch(() => {});
});

const agent = Agent({ id: "issue", name: "Issue" })
  .use({
    id: "notes",
    tools: [
      tool({
        name: "save",
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        async run() {
          return { saved: true as const };
        },
      }),
    ],
  })
  .build();

/** An endpoint that answers every delivery with 202 and keeps each delivery's token. */
async function acceptingEndpoint() {
  const deliveries: { token: string; actionId: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      deliveries.push({
        token: String(request.headers[SIGNATURE_HEADER.toLowerCase()]),
        actionId: JSON.parse(body).action.actionId,
      });
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/actions`, deliveries };
}

async function tenant(options: { leaseMs?: number; sandbox?: boolean } = {}) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    modelProvider: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result")
        return { output: [{ type: "text", text: "done" }] };
      return { output: [{ type: "tool-call", id: "call-1", name: "save", args: { note: "hi" } }] };
    },
  });
  cleanup.push(() => runtime.close());
  const call = async (method: string, path: string, body?: unknown, bearer = APP) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
  };
  await call("PUT", "/v1/agents/issue", { requestId: "put", manifest: agent.manifest, implementationVersion: "dev" });
  if (options.sandbox)
    expect(
      (await call("PUT", "/v1/tenant/sandbox", { requestId: "sandbox", default: "virtual" }, runtime.managementKey))
        .status,
    ).toBe(200);
  const endpoint = await acceptingEndpoint();
  await call("PUT", "/v1/endpoints", { endpoints: [{ agentId: "issue", url: endpoint.url, implementationVersion: "dev" }] });
  await call("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "issue", ownerUserId: "user" });
  await call("POST", "/v1/sessions/s1/commands", { type: "message", requestId: "m1", idempotencyKey: "m1", content: "save" });
  await until(async () => endpoint.deliveries.length, (n) => n === 1);
  return { call, delivery: endpoint.deliveries[0]! };
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

type Call = Awaited<ReturnType<typeof tenant>>["call"];
const status = (call: Call) => async () => (await call("GET", "/v1/sessions/s1")).body.status as string;

it("keeps a 202 delivery alive with heartbeats and records the result posted later", async () => {
  const { call, delivery } = await tenant();
  const beat = await call("POST", `/v1/actions/${delivery.actionId}/heartbeat`, undefined, delivery.token);
  expect(beat.status).toBe(200);
  expect(beat.body).toEqual({ token: expect.any(String), deadlineAt: expect.any(String) });
  expect(beat.body.token).not.toBe(delivery.token);
  const outcome = { value: { kind: "completed", output: { saved: true } } };
  const posted = await call("POST", `/v1/actions/${delivery.actionId}/result`, outcome, beat.body.token);
  expect(posted.status).toBe(200);
  expect(posted.body).toMatchObject({ status: "accepted", turnId: expect.any(String) });
  await until(status(call), (s) => s === "idle" || s === "completed");
  // The same result again answers the same receipt; another one is refused.
  const again = await call("POST", `/v1/actions/${delivery.actionId}/result`, outcome, beat.body.token);
  expect(again).toEqual(posted);
  const other = await call(
    "POST",
    `/v1/actions/${delivery.actionId}/result`,
    { value: { kind: "failed", code: "x", message: "y" } },
    beat.body.token,
  );
  expect(other.status).toBe(409);
});

it("loses a 202 delivery whose endpoint stops heartbeating", async () => {
  const { call, delivery } = await tenant({ leaseMs: 300 });
  await until(status(call), (s) => s === "uncertain");
  const late = await call(
    "POST",
    `/v1/actions/${delivery.actionId}/result`,
    { value: { kind: "completed", output: { saved: true } } },
    delivery.token,
  );
  expect(late.status).toBe(409);
});

it("tells a heartbeating endpoint that the turn was cancelled", async () => {
  const { call, delivery } = await tenant();
  await call("POST", "/v1/sessions/s1/commands", { type: "cancel", requestId: "c1", idempotencyKey: "c1" });
  const beat = await call("POST", `/v1/actions/${delivery.actionId}/heartbeat`, undefined, delivery.token);
  expect(beat.status).toBe(409);
  expect(beat.body.message).toBe("The delivery was cancelled, lost or delivered again");
});

it("runs the session's sandbox tools for the delivery token, and only for its Action", async () => {
  const { call, delivery } = await tenant({ sandbox: true });
  const ran = await call("POST", `/v1/actions/${delivery.actionId}/sandbox/bash`, { command: "echo hi" }, delivery.token);
  expect(ran.status).toBe(200);
  expect(ran.body).toMatchObject({ kind: "completed" });
  const other = await call("POST", "/v1/actions/another/sandbox/bash", { command: "echo hi" }, delivery.token);
  expect(other.status).toBe(404);
  // A delivery token reaches nothing else.
  expect((await call("GET", "/v1/sessions/s1", undefined, delivery.token)).status).toBe(403);
});

it("runs a background tool through the SDK handler: 202, heartbeats, then the result", async () => {
  const { AgentsClient, createActionHandler } = await import("@nylorun/agents");
  const runs: string[] = [];
  const background = Agent({ id: "issue", name: "Issue" })
    .use({
      id: "notes",
      tools: [
        tool({
          name: "save",
          input: z.object({ note: z.string() }),
          output: z.object({ saved: z.literal(true) }),
          background: true,
          async run({ note }) {
            // Longer than the lease, so only heartbeats keep the delivery alive.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            runs.push(note);
            return { saved: true as const };
          },
        }),
      ],
    })
    .build();
  const runtime = await startTestTenant({
    applicationKey: APP,
    leaseMs: 1_200,
    modelProvider: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
      return { output: [{ type: "tool-call", id: "call-1", name: "save", args: { note: "later" } }] };
    },
  });
  cleanup.push(() => runtime.close());
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/actions`;
  const client = new AgentsClient({ url: runtime.url, tenant: runtime.tenantId, key: APP });
  const actions = createActionHandler({ agents: [background], client, url });
  server.on("request", actions.node);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
  };
  await call("PUT", "/v1/agents/issue", { requestId: "put", manifest: background.manifest, implementationVersion: "dev" });
  await call("PUT", "/v1/endpoints", { endpoints: [{ agentId: "issue", url, implementationVersion: "dev" }] });
  await call("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "issue", ownerUserId: "user" });
  await call("POST", "/v1/sessions/s1/commands", { type: "message", requestId: "m1", idempotencyKey: "m1", content: "save" });
  await until(status(call), (s) => s === "idle" || s === "completed");
  expect(runs).toEqual(["later"]);
  const items = (await call("GET", "/v1/sessions/s1/items")).body.items as { type: string; payload: any }[];
  expect(items.find((e) => e.type === "action.completed")!.payload.result).toEqual({
    kind: "completed",
    output: { saved: true },
  });
  expect(items.some((e) => e.type === "action.uncertain")).toBe(false);
});
