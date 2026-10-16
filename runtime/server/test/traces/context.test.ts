/**
 * Trace context in and out (R7.4): a command's `traceparent` is recorded and its turn joins the
 * caller's trace; the turn's context goes to the harness (`TurnStart.trace`), a tool call's to an
 * HTTP tool (`traceparent`, beside `Idempotency-Key`) and to a sandbox command (`TRACEPARENT`).
 * The HTTP tool runs through the gates service (`NYLORUN_TEST_MODEL_GATE=http`), whose Tool Gate
 * reads the context from the call's journal row, and in process.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import type { ModelProvider } from "../../src/core/provider.js";
import type { SandboxBackend } from "../../src/sandbox/types.js";
import { effectSpanOf, traceIdOf, traceparentOf, turnSpanOf } from "../../src/traces/ids.js";
import { traceKey } from "../../src/traces/key.js";
import { deploy, type Loop } from "../support/agents.js";
import { openTestSessionStore } from "../support/store.js";
import { startTestTenant, testHarnessMode } from "../support/tenant.js";

const APP = "r7-context-token-aaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** An HTTP tool that answers `{ ok: true }` and keeps each request's headers. */
async function service() {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, seen };
}

/** Calls `name` once, then answers. */
function oneCall(name: string, args: Record<string, unknown>): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    if (prompt.some((item) => item.kind === "tool-result")) return { output: [{ type: "text", text: "done" }] };
    return { output: [{ type: "tool-call", id: "call-1", name, args }] };
  };
}

async function boot(options: { model: ModelProvider; manifest: Loop; sandbox?: SandboxBackend }) {
  const frames: { frame: any }[] = [];
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: options.model,
    harnessTap: (frame) => frames.push({ frame }),
    ...(options.sandbox ? { sandbox: { backend: "virtual" as const, backends: [options.sandbox] } } : {}),
  });
  open.push(() => runtime.close());
  const put = async (path: string, body: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(response.ok, await response.clone().text()).toBe(true);
  };
  const agent = options.sandbox ? "ws/s1" : "bot";
  await deploy(runtime.url, headers, options.manifest, {
    id: agent,
    ...(options.sandbox ? { runtime: { kind: "virtual" as const } } : {}),
  });
  await put("/v1/sessions/s1", { requestId: "s1", agent, ownerUserId: "u" });
  const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
  const key = await traceKey(store).finally(() => store.close());
  return { runtime, frames, key };
}

async function say(url: string, extra: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { turnId: string }).turnId;
}

async function settled(url: string): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { status } = (await (await fetch(`${url}/v1/sessions/s1`, { headers })).json()) as { status: string };
    if (["completed", "failed", "cancelled"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The turn did not settle");
}

async function items(url: string) {
  const body = (await (await fetch(`${url}/v1/sessions/s1/items`, { headers })).json()) as {
    items: { type: string; payload: Record<string, any> }[];
  };
  return body.items;
}

const hookAgent = (url: string) =>
  Agent({ id: "bot", name: "Bot" })
    .tools(http({ name: "hook", input: z.object({ n: z.number() }), url }))
    .build().manifest;

describe("trace context (R7.4)", { timeout: 60_000 }, () => {
  for (const gate of ["http", "in-process"] as const)
    it(`sends an HTTP tool its span's traceparent beside Idempotency-Key (${gate} Tool Gate), under the caller's trace`, async () => {
      if (gate === "http") vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
      const target = await service();
      const { runtime, frames, key } = await boot({ model: oneCall("hook", { n: 1 }), manifest: hookAgent(target.url) });
      const turnId = await say(runtime.url, { traceparent: INBOUND, tracestate: "vendor=1" });
      expect(await settled(runtime.url)).toBe("completed");
      const log = await items(runtime.url);
      expect(log.find((item) => item.type === "command.message")?.payload.trace).toEqual({
        traceparent: INBOUND,
        tracestate: "vendor=1",
      });
      const tool = log.find((item) => item.type === "tool.completed")!.payload;
      expect(target.seen).toHaveLength(1);
      expect(target.seen[0]!["idempotency-key"]).toBe(tool.effectId);
      expect(target.seen[0]!.traceparent).toBe(
        traceparentOf("4bf92f3577b34da6a3ce929d0e0e4736", effectSpanOf(key, tool.effectId)),
      );
      // The harness gets the turn's span context, in the caller's trace (the frames of an
      // in-process harness's channel only).
      if (testHarnessMode() === "ws") return;
      const start = frames.map(({ frame }) => frame?.r?.input).find((input) => input?.type === "turn.start");
      expect(start.trace).toEqual({
        traceparent: traceparentOf("4bf92f3577b34da6a3ce929d0e0e4736", turnSpanOf(key, turnId)),
        tracestate: "vendor=1",
      });
    });

  it("derives the trace without a traceparent, and ignores a malformed one", async () => {
    const target = await service();
    const { runtime, key, frames } = await boot({ model: oneCall("hook", { n: 2 }), manifest: hookAgent(target.url) });
    const turnId = await say(runtime.url, { traceparent: "00-zz-yy-01" });
    expect(await settled(runtime.url)).toBe("completed");
    const log = await items(runtime.url);
    expect(log.find((item) => item.type === "command.message")?.payload.trace).toBeUndefined();
    const traceId = traceIdOf(key, runtime.tenantId, "s1", turnId);
    const tool = log.find((item) => item.type === "tool.completed")!.payload;
    expect(target.seen[0]!.traceparent).toBe(traceparentOf(traceId, effectSpanOf(key, tool.effectId)));
    if (testHarnessMode() === "ws") return;
    const start = frames.map(({ frame }) => frame?.r?.input).find((input) => input?.type === "turn.start");
    expect(start.trace).toEqual({ traceparent: traceparentOf(traceId, turnSpanOf(key, turnId)) });
  });

  it("hands a sandbox command its call's span as TRACEPARENT", async () => {
    const envs: Record<string, string>[] = [];
    const backend: SandboxBackend = {
      name: "virtual",
      isolation: "process",
      probe: async () => ({ name: "virtual", isolation: "process", available: true, reason: "test" }),
      unmet: () => undefined,
      open: async () => ({
        async exec(request: { env?: Record<string, string> }) {
          envs.push(request.env ?? {});
          return { exitCode: 0, stdout: "ok", stderr: "", killed: false, timedOut: false };
        },
        readFile: async () => undefined,
        writeFile: async () => {},
        stop: async () => {},
      }),
      remove: async () => {},
      list: async () => [],
    } as unknown as SandboxBackend;
    const manifest = Agent({ id: "bot", name: "Bot" }).build().manifest;
    const { runtime, key } = await boot({ model: oneCall("bash", { command: "echo hi" }), manifest, sandbox: backend });
    const turnId = await say(runtime.url);
    expect(await settled(runtime.url)).toBe("completed");
    const tool = (await items(runtime.url)).find((item) => item.type === "tool.completed")!.payload;
    expect(tool.kind).toBe("sandbox");
    expect(envs.at(-1)?.TRACEPARENT).toBe(
      traceparentOf(traceIdOf(key, runtime.tenantId, "s1", turnId), effectSpanOf(key, tool.effectId)),
    );
  });
});
