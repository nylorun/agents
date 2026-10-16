/**
 * The R5 exit (step 1), as the design proposes it: every tool call in a session, cancelled ones
 * included, appears in the log with its outcome and as a row at `/calls/tool`. A call
 * interrupted by a crash is sent again with the same key, and the session continues. A sandbox
 * command interrupted by a crash, or any call interrupted three times, fails to the model. A
 * harness that skips the journal gets nothing run.
 *
 * The gates run over HTTP (`NYLORUN_TEST_MODEL_GATE=http`), as in the local stack. A lost gate hop
 * is a Tool Gate client that stops waiting for an answer it sent for (`lostHops`); a crash is a
 * takeover of a session whose owner died mid call.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import { HTTP_CALLS_PATH } from "../src/gates/tool-contract.js";
import { GateCallLost, httpToolGate } from "../src/gates/tool-client.js";
import type { ToolGate } from "../src/gates/tool-gate.js";
import type { ModelProvider } from "../src/core/provider.js";
import { MemoryExecution } from "../src/execution/memory.js";
import type { SandboxBackend } from "../src/sandbox/types.js";
import type { TenantRuntime } from "../src/tenant/runtime.js";
import { TenantWorkers } from "../src/tenant/worker.js";
import { deploy } from "./support/agents.js";
import { openTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "r5-exit-token-aaaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/**
 * A refund service that dedupes on `Idempotency-Key`, as the docs ask: a key it has seen gets
 * the first answer, and acts once. Each request waits until `release()`.
 */
async function refundService(options: { hold?: boolean } = {}) {
  const requests: { key: string; body: unknown }[] = [];
  const refunds = new Map<string, number>();
  let release!: () => void;
  const released = options.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  if (!options.hold) release = () => {};
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const key = String(req.headers["idempotency-key"]);
    requests.push({ key, body: JSON.parse(Buffer.concat(chunks).toString() || "null") });
    entered();
    await released;
    if (!refunds.has(key)) refunds.set(key, refunds.size + 1);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refund: refunds.get(key) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/refunds`,
    started,
    release: () => release(),
    requests: () => [...requests],
    /** Refunds the service made: one per distinct key. */
    refunds: () => refunds.size,
  };
}

/** Calls `name` once with `args`, then answers with the tool result it read. */
function oneCall(name: string, args: Record<string, unknown>, seen: unknown[] = []): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const result = prompt.find((item) => item.kind === "tool-result");
    if (result) {
      seen.push(result);
      return { output: [{ type: "text", text: "done" }] };
    }
    return { output: [{ type: "tool-call", id: "call-1", name, args }] };
  };
}

/**
 * A Tool Gate client of the test gate whose first `lost` HTTP calls lose their hop: each is sent,
 * and once the gate holds it (`sent()` resolves) the client stops waiting and throws
 * `GateCallLost`, as after a gateway restart. The harness then sends the call again; later sends
 * pass through.
 */
function lostHops(lost: number, sent: () => Promise<void>): { toolGate: ToolGate; connect(runtime: Started): void } {
  let target: ToolGate | undefined;
  let calls = 0;
  const live = () => {
    if (!target) throw new Error("Not connected yet");
    return target;
  };
  return {
    toolGate: {
      recovers: true,
      openMcp: (server) => live().openMcp!(server),
      async callHttp(call, signal) {
        calls += 1;
        if (calls > lost) return live().callHttp!(call, signal);
        const abandoned = new AbortController();
        // The call goes on at the gate; only this hop gives up on it.
        void live().callHttp!(call, abandoned.signal).catch(() => undefined);
        await sent();
        await new Promise((resolve) => setTimeout(resolve, 50));
        abandoned.abort(new Error("hop lost"));
        throw new GateCallLost("The tool gate connection was lost");
      },
      cancel: (request) => live().cancel!(request),
    },
    connect(runtime) {
      const gate = runtime.gate!;
      target = httpToolGate({ url: gate.url, token: gate.token, runTokens: gate.runGrants });
    },
  };
}

async function boot(options: {
  model: ModelProvider;
  agent: ReturnType<ReturnType<typeof Agent>["build"]>;
  toolGate?: ToolGate;
  manual?: boolean;
  sandbox?: SandboxBackend;
}): Promise<Started> {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: options.model,
    ...(options.toolGate ? { toolGate: options.toolGate } : {}),
    ...(options.manual
      ? {
          // Never started: only the test advances.
          execution: { execution: new MemoryExecution(), workers: new TenantWorkers() },
          workerId: "worker-a",
          ownerLeaseMs: 60_000,
          sweepIntervalMs: 60_000,
        }
      : {}),
    ...(options.sandbox ? { sandbox: { backend: "virtual" as const, backends: [options.sandbox] } } : {}),
  });
  open.push(() => runtime.close());
  const agent = options.sandbox ? "ws/s1" : "bot";
  await deploy(runtime.url, headers, options.agent, {
    id: agent,
    ...(options.sandbox ? { runtime: { kind: "virtual" as const } } : {}),
  });
  const response = await fetch(`${runtime.url}/v1/sessions/s1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ requestId: "session-s1", agent, ownerUserId: "u" }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return runtime;
}

const say = async (runtime: Started) =>
  expect(
    (
      await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" }),
      })
    ).ok,
  ).toBe(true);

async function status(runtime: Started): Promise<string> {
  return ((await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string }).status;
}

async function settled(runtime: Started): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const now = await status(runtime);
    if (["completed", "failed", "cancelled", "uncertain"].includes(now)) return now;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The turn did not settle");
}

async function toolEvents(runtime: Started) {
  const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
    items: { type: string; payload: Record<string, unknown> }[];
  };
  return body.items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
}

async function toolCalls(runtime: Started) {
  const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/calls/tool`, { headers })).json()) as {
    calls: Record<string, unknown>[];
  };
  return body.calls;
}

const refund = (url: string) => http({ name: "refund", input: z.object({ charge: z.string(), amount: z.number() }), url });
const refundAgent = (url: string) => Agent({ id: "bot", name: "Bot" }).tools(refund(url)).build();

describe("the R5 exit", { timeout: 60_000 }, () => {
  it("records a call that ran, in the log and at /calls/tool, with its key on the request", async () => {
    const service = await refundService();
    const runtime = await boot({ model: oneCall("refund", { charge: "ch_1", amount: 30 }), agent: refundAgent(service.url) });
    await say(runtime);
    expect(await settled(runtime)).toBe("completed");
    const [event] = await toolEvents(runtime);
    expect(event).toMatchObject({ toolName: "refund", status: "completed", kind: "http", attempts: 1, output: { refund: 1 } });
    expect(typeof event!.durationMs).toBe("number");
    const [row] = await toolCalls(runtime);
    expect(row).toMatchObject({
      callId: "call-1",
      toolName: "refund",
      kind: "http",
      status: "completed",
      attempts: 1,
      input: { charge: "ch_1", amount: 30 },
      error: null,
    });
    expect(service.requests().map((request) => request.key)).toEqual([row!.effectId]);
    // Its span (R7.1): the effect id, and the Tool Gate's own start and end from its crossing.
    expect(event!.effectId).toBe(row!.effectId);
    const gate = event!.gate as { startedAt: string; endedAt: string };
    expect(Date.parse(gate.endedAt)).toBeGreaterThanOrEqual(Date.parse(gate.startedAt));
    expect(event!.policy).toBeUndefined();
  });

  it("sends a call whose gate hop lost the answer again, with the same key; the service acts once", async () => {
    const service = await refundService({ hold: true });
    const hop = lostHops(1, () => service.started);
    const runtime = await boot({
      model: oneCall("refund", { charge: "ch_2", amount: 30 }),
      agent: refundAgent(service.url),
      toolGate: hop.toolGate,
    });
    hop.connect(runtime);
    await say(runtime);
    // The first hop gives up; the harness sends the call again, and the gate joins it.
    await vi.waitFor(async () => expect((await toolCalls(runtime))[0]).toMatchObject({ attempts: 2 }), {
      timeout: 20_000,
    });
    service.release();
    expect(await settled(runtime)).toBe("completed");
    expect(await toolEvents(runtime)).toEqual([
      expect.objectContaining({ status: "completed", attempts: 2, output: { refund: 1 } }),
    ]);
    expect(service.refunds()).toBe(1);
    expect(new Set(service.requests().map((request) => request.key)).size).toBe(1);
  });

  it("fails a call interrupted three times to the model as tool.interrupted, and the session continues", async () => {
    const service = await refundService({ hold: true });
    const hop = lostHops(3, () => service.started);
    const seen: unknown[] = [];
    const runtime = await boot({
      model: oneCall("refund", { charge: "ch_3", amount: 30 }, seen),
      agent: refundAgent(service.url),
      toolGate: hop.toolGate,
    });
    hop.connect(runtime);
    await say(runtime);
    expect(await settled(runtime)).toBe("completed");
    expect(JSON.stringify(seen)).toContain("tool.interrupted");
    const [event] = await toolEvents(runtime);
    expect(event).toMatchObject({ status: "failed", attempts: 3, error: { code: "tool.interrupted" } });
    expect((await toolCalls(runtime))[0]).toMatchObject({ status: "failed", attempts: 3 });
    // Every send joined the one call the gate held: the service saw it once.
    expect(service.requests()).toHaveLength(1);
    service.release();
  });

  it("ends a call a cancel stopped as cancelled, in the log and at /calls/tool", async () => {
    const service = await refundService({ hold: true });
    const runtime = await boot({ model: oneCall("refund", { charge: "ch_4", amount: 30 }), agent: refundAgent(service.url) });
    await say(runtime);
    await service.started;
    const cancelled = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "cancel", requestId: "c1", idempotencyKey: "c1" }),
    });
    expect(cancelled.ok).toBe(true);
    expect(await toolEvents(runtime)).toEqual([
      expect.objectContaining({ status: "cancelled", error: expect.objectContaining({ code: "tool.cancelled" }) }),
    ]);
    expect((await toolCalls(runtime))[0]).toMatchObject({ status: "cancelled" });
    // The cancelled turn's span (R7.1).
    const items = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
      items: { type: string; payload: Record<string, unknown> }[];
    };
    expect(items.items.find((item) => item.type === "turn.cancelled")?.payload).toMatchObject({
      durationMs: expect.any(Number),
      agentId: "bot",
      totals: { steps: expect.any(Number), tokens: expect.any(Number), costUsd: expect.any(Number) },
    });
  });

  it("fails a sandbox command a crash interrupted to the model, and never runs it again (Q2)", async () => {
    let execs = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const backend: SandboxBackend = {
      name: "virtual",
      isolation: "process",
      probe: async () => ({ name: "virtual", isolation: "process", available: true, reason: "test" }),
      unmet: () => undefined,
      open: async () => ({
        async exec() {
          execs += 1;
          entered();
          await released;
          return { exitCode: 0, stdout: "", stderr: "", killed: false, timedOut: false };
        },
        readFile: async () => undefined,
        writeFile: async () => {},
        stop: async () => {},
      }),
      remove: async () => {},
      list: async () => [],
    };
    const seen: unknown[] = [];
    const runtime = await boot({
      model: oneCall("bash", { command: "git push" }, seen),
      agent: Agent({ id: "bot", name: "Bot" }).build(),
      manual: true,
      sandbox: backend,
    });
    open.push(async () => release());
    await say(runtime);
    const worker = (runtime.handle as TenantRuntime).worker;
    const stale = worker.advance("s1", new AbortController().signal);
    await started; // `bash` is invoking under worker-a
    // The owner died: another Worker's lease on the session has expired too.
    const other = await openTestSessionStore(runtime);
    try {
      const taken = await other.tx((t) =>
        t.takeOwnership("s1", { owner: "worker-dead", now: new Date(Date.now() + 120_000), leaseMs: -240_000 }),
      );
      expect(taken).toMatchObject({ status: "owned", takeover: true });
    } finally {
      await other.close();
    }
    // The dead owner's command ends; its outcome is fenced: the epoch moved on.
    release();
    await stale;
    expect(await worker.advance("s1", new AbortController().signal)).toEqual({ status: "done" });
    expect(await status(runtime)).toBe("completed");
    expect(JSON.stringify(seen)).toContain("tool.interrupted");
    expect(await toolEvents(runtime)).toEqual([
      expect.objectContaining({ toolName: "bash", kind: "sandbox", status: "failed", attempts: 1 }),
    ]);
    expect(execs).toBe(1);
  });

  it("runs nothing for a harness that skips the journal", async () => {
    const service = await refundService({ hold: true });
    const runtime = await boot({ model: oneCall("refund", { charge: "ch_5", amount: 30 }), agent: refundAgent(service.url) });
    await say(runtime);
    await service.started; // the run's token is live, and its refund journaled and running
    const gate = runtime.gate!;
    const token = gate.runGrants.token("s1")!;
    const [row] = await toolCalls(runtime);
    const probe = (key: string | undefined, input: unknown) =>
      fetch(new URL(HTTP_CALLS_PATH, gate.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: JSON.stringify({ tool: { toolName: "refund" }, effectId: key ?? "x", turnId: "t", input }),
      });
    const unkeyed = await probe(undefined, { charge: "ch_5", amount: 30 });
    expect(unkeyed.status).toBe(400);
    expect(await unkeyed.json()).toMatchObject({ error: { code: "key_required" } });
    const invented = await probe("turn-x:0:tool:made-up", { charge: "ch_5", amount: 30 });
    expect(invented.status).toBe(409);
    expect(await invented.json()).toMatchObject({ error: { code: "effect_not_journaled" } });
    const changed = await probe(row!.effectId as string, { charge: "ch_5", amount: 120_000 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "effect_not_journaled" } });
    service.release();
    expect(await settled(runtime)).toBe("completed");
    expect(service.requests()).toHaveLength(1);
    expect(service.refunds()).toBe(1);
  });
});
