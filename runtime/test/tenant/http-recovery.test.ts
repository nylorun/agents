/**
 * R2 M3: an HTTP tool call whose answer was lost with the process that made it is treated as a
 * remote MCP call is (`mcp-recovery.test.ts`). Through the Tool Gate the call outlives the Worker
 * that sent it: the next advance re-sends it under the same key and joins it, so the service
 * gets one request. Made in the Worker's own process, a call its dead owner left running may
 * have reached the service: it is `uncertain` and never sent again.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import { openTestSessionStore } from "../support/store.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "http-recovery-token-aaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** A service that holds every request until `release()`, keeping their idempotency keys. */
async function heldService() {
  const keys: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req);
    keys.push(String(req.headers["idempotency-key"]));
    entered();
    await released;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ done: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`,
    started,
    release: () => release(),
    keys: () => [...keys],
  };
}

const model: ModelProvider = async (effect: { input: unknown }) => {
  const call = effect.input as { prompt?: { kind?: string }[] };
  if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "slow", args: { value: 7 } }] };
};

async function boot(url: string): Promise<Started> {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: model,
    execution: { execution: new MemoryExecution(), workers: new TenantWorkers() }, // only the test advances
    workerId: "worker-a",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  open.push(() => runtime.close());
  const agent = Agent({ id: "bot", name: "Bot" })
    .tools(http({ name: "slow", input: z.object({ value: z.number() }), url }))
    .build();
  for (const [path, body] of [
    ["/v1/agents/bot", { requestId: "put-1", manifest: agent.manifest, implementationVersion: "dev" }],
    ["/v1/sessions/s1", { requestId: "session-s1", agentId: "bot", ownerUserId: "u" }],
  ] as const) {
    const response = await fetch(`${runtime.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
  }
  const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "hello" }),
  });
  expect(message.ok).toBe(true);
  return runtime;
}

const workerOf = (runtime: Started) => (runtime.handle as TenantRuntime).worker;

async function status(runtime: Started) {
  return ((await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string }).status;
}

async function types(runtime: Started) {
  const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
    items: { type: string }[];
  };
  return body.items.map((item) => item.type);
}

it("finishes a turn whose Worker shut down mid HTTP call at the gate, with one request", async () => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
  const service = await heldService();
  const runtime = await boot(service.url);
  const stopping = new AbortController();
  const first = workerOf(runtime).advance("s1", stopping.signal);
  await service.started;
  stopping.abort(new Error("The Worker is stopping")); // a shutdown, not a cancel
  await first;
  expect(await types(runtime)).not.toContain("effect.uncertain");

  const worker = workerOf(runtime);
  const next = (async () => {
    let result = await worker.advance("s1", new AbortController().signal);
    for (let attempt = 0; result.status === "busy" && attempt < 50; attempt += 1)
      result = await worker.advance("s1", new AbortController().signal);
    return result;
  })();
  service.release();
  expect(await next).toEqual({ status: "done" });
  expect(await status(runtime)).toBe("completed");
  expect(await types(runtime)).not.toContain("effect.uncertain");
  expect(service.keys()).toHaveLength(1);
});

it("marks an HTTP call its dead owner made in process uncertain, and never sends it again", async () => {
  // In process even when the suite runs the gates over HTTP (the integration job).
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "");
  const service = await heldService();
  const runtime = await boot(service.url);
  const stale = workerOf(runtime).advance("s1", new AbortController().signal);
  await service.started; // the effect is `invoking` under worker-a

  // Another Worker took the session over and died too: its lease already expired.
  const other = await openTestSessionStore(runtime);
  try {
    const taken = await other.tx((t) =>
      t.takeOwnership("s1", { owner: "worker-dead", now: new Date(Date.now() + 120_000), leaseMs: -240_000 }),
    );
    expect(taken).toMatchObject({ status: "owned", takeover: true });
  } finally {
    await other.close();
  }
  await workerOf(runtime).advance("s1", new AbortController().signal);
  expect(await status(runtime)).toBe("uncertain");
  expect(await types(runtime)).toContain("effect.uncertain");
  service.release();
  await stale;
  expect(service.keys()).toHaveLength(1);
});
