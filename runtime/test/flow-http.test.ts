/**
 * HTTP in flows, end to end: an `http()` tool as a flow stage and `http({ url })` as a Loop's
 * verifier. The Runtime makes each request through its Tool Gate as for an agent's HTTP tool (in
 * process, or the gates service with `NYLORUN_TEST_MODEL_GATE=http`,
 * `gates/tool-gate-flow-http.test.ts`): the identity headers with the flow agent's id, the flow
 * effect id as `Idempotency-Key` and the vault credential. A failed request fails the stage; a
 * verifier's verdict is recorded as `loop.verified`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createClient, http, type AgentsClient, type BuiltWorkflow } from "@nylorun/agents";
import type { HostEffect } from "@nylorun/harness/run";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "flow-http-app-token-aaaaaaaaaaaaa";
const TOKEN = "checks-secret-token-5d1e8b7c";

interface Seen {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: any;
}

/** The developer's service. `/verify` fails the first attempt with feedback, then passes. */
async function service(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ path, headers: req.headers, body });
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/refunds") return json({ refundId: `r-${body.orderId}` });
    if (path === "/wrong") return json({ refund: 1 });
    if (path === "/verify")
      return json(body.iteration >= 2 ? { pass: true } : { pass: false, feedback: "add a test" });
    if (path === "/odd") return json({ ok: true });
    res.writeHead(422, { "content-type": "text/plain" });
    res.end("amount is larger than the order");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/** `orders` names an order; `fixer` counts its attempts. */
const model: ModelProvider = (async (effect: HostEffect) => {
  if (effect.agentId === "orders") return { output: [{ type: "json", value: { orderId: "A-1" } }] };
  return { output: [{ type: "text", text: `${effect.agentId} done` }] };
}) as ModelProvider;

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
type Event = { type: string; sessionId: string; payload: any };
let target: Awaited<ReturnType<typeof service>>;
let runtime: Runtime;
let client: AgentsClient;
let sessions = 0;

beforeAll(async () => {
  target = await service();
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
});

afterAll(async () => {
  await runtime?.close();
  await new Promise((resolve) => target.server.close(resolve));
});

const Order = z.object({ orderId: z.string() });
const orders = Agent({ id: "orders" }).instructions("Name the order.").output(Order);
const fixer = Agent({ id: "fixer" }).instructions("Fix it.");
const stage = (name: string, path: string, extra: { credential?: string } = {}) =>
  http({ name, input: Order, output: z.object({ refundId: z.string() }), url: `${target.url}${path}`, ...extra });

/** Saves `workflow`, runs one turn, and returns its events. */
async function run(workflow: BuiltWorkflow, options: { vaultIds?: string[] } = {}) {
  const put = await fetch(`${runtime.url}/v1/agents/${workflow.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: `put-${(sessions += 1)}`, manifest: workflow.manifest, implementationVersion: "dev" }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  const session = await client.createSession({
    id: `flow-http-${sessions}`,
    agentId: workflow.id,
    ownerUserId: "ada",
    ...(options.vaultIds ? { vaultIds: options.vaultIds } : {}),
  });
  const events: Event[] = [];
  const done = (async () => {
    for await (const event of session.observe()) {
      events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
      if (event.sessionId === session.id && (event.type === "turn.completed" || event.type === "turn.failed"))
        return true;
    }
    return false;
  })();
  await session.input("go", { idempotencyKey: `m-${sessions}` });
  const settled = await Promise.race([done, new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]);
  if (!settled)
    throw new Error(`turn did not settle; events:\n${events.map((e) => `${e.type} ${JSON.stringify(e.payload)}`).join("\n")}`);
  const last = events.at(-1)!;
  return { session, last, events, own: events.filter((e) => e.sessionId === session.id) };
}

describe("an HTTP stage", { timeout: 30_000 }, () => {
  it("sends the previous output with the flow's identity headers and run-once key; its answer is the next input", async () => {
    const before = target.seen.length;
    const desk = Agent({ id: "refund-desk" }).pipe(orders, stage("refund", "/refunds")).build();
    const { session, last, own } = await run(desk);
    expect(last.type, JSON.stringify(last.payload)).toBe("turn.completed");
    expect(last.payload.output).toEqual({ refundId: "r-A-1" });
    const [request] = target.seen.slice(before);
    expect(target.seen.length - before).toBe(1);
    expect(request).toMatchObject({ path: "/refunds", body: { orderId: "A-1" } });
    expect(request!.headers["nylorun-session-id"]).toBe(session.id);
    expect(request!.headers["nylorun-agent-id"]).toBe("refund-desk");
    const turnId = request!.headers["nylorun-turn-id"] as string;
    expect(request!.headers["idempotency-key"]).toBe(`${turnId}:0:flow:refund:tool:-`);
    expect(own.find((e) => e.type === "node.started" && e.payload.kind === "http")?.payload).toMatchObject({
      path: "refund",
      key: "refund",
    });
    // Never an Action.
    expect(own.some((e) => e.type === "action.pending")).toBe(false);
  });

  it("fails the stage on a failure status, with the start of its body", async () => {
    const { last } = await run(Agent({ id: "failing-desk" }).pipe(orders, stage("refund", "/fail")).build());
    expect(last.type).toBe("turn.failed");
    expect(JSON.stringify(last.payload)).toContain("http.status");
    expect(JSON.stringify(last.payload)).toContain("The service answered HTTP 422: amount is larger than the order");
  });

  it("fails the stage when the answer does not match its output schema", async () => {
    const { last } = await run(Agent({ id: "wrong-desk" }).pipe(orders, stage("refund", "/wrong")).build());
    expect(last.type).toBe("turn.failed");
    expect(JSON.stringify(last.payload)).toContain("tool.invalid-output");
  });

  it("adds the session's vault credential bound to the stage's URL", async () => {
    const vault = await (
      await fetch(`${runtime.url}/v1/tenant/vaults`, {
        method: "POST",
        headers: runtime.managementHeaders(),
        body: JSON.stringify({ requestId: "vault-flow", idempotencyKey: "vault-flow", name: "Checks", ownerUserId: "ada" }),
      })
    ).json();
    const created = await fetch(`${runtime.url}/v1/tenant/vaults/${vault.id}/credentials`, {
      method: "POST",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        requestId: "cred-checks",
        idempotencyKey: "cred-checks",
        name: "checks",
        auth: { type: "bearer", url: `${target.url}/refunds`, token: TOKEN },
      }),
    });
    expect(created.ok).toBe(true);
    const before = target.seen.length;
    const desk = Agent({ id: "billed-desk" }).pipe(orders, stage("refund", "/refunds", { credential: "checks" })).build();
    const { last, events } = await run(desk, { vaultIds: [vault.id] });
    expect(last.type, JSON.stringify(last.payload)).toBe("turn.completed");
    expect(target.seen.slice(before).map((item) => item.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    // Without the vault, the request never leaves and the stage fails.
    const bare = await run(desk);
    expect(bare.last.type).toBe("turn.failed");
    expect(JSON.stringify(bare.last.payload)).toContain("http.credential");
    expect(target.seen.length).toBe(before + 1);
  });
});

describe("an HTTP verifier", { timeout: 30_000 }, () => {
  it("retries the body with the feedback until it passes, and records each verdict", async () => {
    const before = target.seen.length;
    const desk = Agent({ id: "verified-desk" })
      .loop(fixer, { verify: http({ url: `${target.url}/verify` }), max: 3, id: "fix" })
      .build();
    const { session, last, own } = await run(desk);
    expect(last.type, JSON.stringify(last.payload)).toBe("turn.completed");
    expect(last.payload.output).toBe("fixer done");
    const calls = target.seen.slice(before);
    expect(calls.map((call) => call.body)).toEqual([
      { input: "go", output: "fixer done", iteration: 1 },
      { input: "go", output: "fixer done", iteration: 2 },
    ]);
    expect(calls[0]!.headers["nylorun-agent-id"]).toBe("verified-desk");
    expect(calls[0]!.headers["nylorun-session-id"]).toBe(session.id);
    const turnId = calls[0]!.headers["nylorun-turn-id"] as string;
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual([
      `${turnId}:0:flow:@0.verify:tool:1`,
      `${turnId}:0:flow:@0.verify:tool:2`,
    ]);
    expect(own.filter((e) => e.type === "loop.verified").map((e) => e.payload)).toEqual([
      { path: "fix", n: 1, pass: false, feedback: "add a test" },
      { path: "fix", n: 2, pass: true },
    ]);
    expect(own.filter((e) => e.type === "loop.iteration")).toHaveLength(2);
  });

  it("fails loop.verify-failed for an answer that is not a verdict, and records none", async () => {
    const desk = Agent({ id: "odd-desk" })
      .loop(fixer, { verify: http({ url: `${target.url}/odd` }), max: 2 })
      .build();
    const { last, own } = await run(desk);
    expect(last.type).toBe("turn.failed");
    expect(JSON.stringify(last.payload)).toContain("loop.verify-failed");
    expect(JSON.stringify(last.payload)).toContain("The verifier must return { pass: boolean, feedback?: string }");
    expect(own.some((e) => e.type === "loop.verified")).toBe(false);
  });

  it("fails loop.verify-failed when the request fails", async () => {
    const desk = Agent({ id: "down-desk" })
      .loop(fixer, { verify: http({ url: `${target.url}/missing` }), max: 2 })
      .build();
    const { last } = await run(desk);
    expect(last.type).toBe("turn.failed");
    expect(JSON.stringify(last.payload)).toContain("loop.verify-failed");
    expect(JSON.stringify(last.payload)).toContain("The service answered HTTP 422");
  });
});
