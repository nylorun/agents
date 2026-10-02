/**
 * P1.2: a model call that outlives the process that sent it. With the gates service
 * (`NYLORUN_TEST_MODEL_GATE=http`: a gate on 127.0.0.1 in this process), a call keeps running
 * at the gate when its owner dies or shuts down; the next advance re-sends it from the journal
 * and joins it, so the turn completes with one provider call and nothing `uncertain`. A user
 * cancel still stops the provider request. The in-process gate keeps today's behaviour
 * (`ownership.test.ts`).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { openTestSessionStore } from "../support/store.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { TenantWorkers, type TenantExecution } from "../../src/tenant/worker.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "recovery-app-token-aaaaaaaaaaaaaa";
const PROVIDER = "https://models.recovery.invalid/v1";
const realFetch = globalThis.fetch;
const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: Started[] = [];
beforeEach(() => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const runtime of open.splice(0).reverse()) await runtime.close().catch(() => undefined);
});

/** The provider: holds every call until `release()`, counting calls and aborts. */
function heldProvider() {
  let calls = 0;
  let aborted = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      calls += 1;
      entered();
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(signal.reason);
        });
      });
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk({ role: "assistant", content: "recovered" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return { started, release: () => release(), calls: () => calls, aborted: () => aborted };
}

function hostExecution(): TenantExecution & { execution: MemoryExecution } {
  return { execution: new MemoryExecution(), workers: new TenantWorkers() };
}

async function boot() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    useHostModel: true,
    execution: hostExecution(), // never started: only the test advances
    workerId: "worker-a",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  open.push(runtime);
  const configured = await realFetch(`${runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "test-model",
      baseUrl: PROVIDER,
      auth: { type: "api_key", key: "recovery-provider-key" },
    }),
  });
  expect(configured.status).toBe(200);
  const agent = Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build();
  for (const [path, body] of [
    ["/v1/agents/bot", { requestId: "put-1", manifest: agent.manifest, implementationVersion: "dev" }],
    ["/v1/sessions/s1", { requestId: "session-s1", agentId: "bot", ownerUserId: "u" }],
  ] as const) {
    const response = await realFetch(`${runtime.url}${path}`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  }
  return runtime;
}

const command = (runtime: Started, body: Record<string, unknown>) =>
  realFetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify(body),
  });

const message = (runtime: Started) =>
  command(runtime, { type: "message", requestId: "m1", idempotencyKey: "m1", content: "hello" });

async function view(runtime: Started) {
  return (await (await realFetch(`${runtime.url}/v1/sessions/s1`, { headers: server })).json()) as {
    status: string;
  };
}

async function types(runtime: Started) {
  const body = (await (
    await realFetch(`${runtime.url}/v1/sessions/s1/items`, { headers: server })
  ).json()) as { items: { type: string }[] };
  return body.items.map((item) => item.type);
}

const workerOf = (runtime: Started) => (runtime.handle as TenantRuntime).worker;

it("finishes a turn whose owner died mid-call: the next advance re-sends the call and joins it", async () => {
  const provider = heldProvider();
  const runtime = await boot();
  expect((await message(runtime)).ok).toBe(true);
  const worker = workerOf(runtime);
  const stale = worker.advance("s1", new AbortController().signal);
  await provider.started; // the model effect is `invoking` under worker-a, and held at the gate

  // Another Worker took the session over and died too: its lease already expired.
  const other = await openTestSessionStore(runtime);
  try {
    const taken = await other.tx((t) =>
      t.takeOwnership("s1", {
        owner: "worker-dead",
        now: new Date(Date.now() + 120_000),
        leaseMs: -240_000,
      }),
    );
    expect(taken).toMatchObject({ status: "owned", takeover: true });
  } finally {
    await other.close();
  }

  const next = worker.advance("s1", new AbortController().signal);
  await vi.waitFor(async () => expect((await view(runtime)).status).toBe("running"));
  provider.release();
  expect(await next).toEqual({ status: "done" });
  await stale;

  expect((await view(runtime)).status).toBe("completed");
  const events = await types(runtime);
  expect(events).not.toContain("effect.uncertain");
  expect(events.filter((type) => type === "message.assistant")).toHaveLength(1);
  expect(provider.calls()).toBe(1);
});

it("finishes a turn whose Worker shut down mid-call, with one provider call", async () => {
  const provider = heldProvider();
  const runtime = await boot();
  expect((await message(runtime)).ok).toBe(true);
  const worker = workerOf(runtime);
  const stopping = new AbortController();
  const first = worker.advance("s1", stopping.signal);
  await provider.started;
  stopping.abort(new Error("The Worker is stopping")); // a shutdown, not a cancel
  await first;
  expect(await types(runtime)).not.toContain("effect.uncertain");

  const next = worker.advance("s1", new AbortController().signal);
  provider.release();
  let result = await next;
  for (let attempt = 0; result.status === "busy" && attempt < 50; attempt += 1)
    result = await worker.advance("s1", new AbortController().signal);
  expect(result).toEqual({ status: "done" });

  expect((await view(runtime)).status).toBe("completed");
  expect(await types(runtime)).not.toContain("effect.uncertain");
  expect(provider.calls()).toBe(1);
  expect(provider.aborted()).toBe(0);
});

it("stops the provider request when the user cancels mid-call", async () => {
  const provider = heldProvider();
  const runtime = await boot();
  expect((await message(runtime)).ok).toBe(true);
  const running = workerOf(runtime).advance("s1", new AbortController().signal);
  await provider.started;
  expect((await command(runtime, { type: "cancel", requestId: "c1", idempotencyKey: "c1" })).ok).toBe(true);
  await vi.waitFor(() => expect(provider.aborted()).toBe(1));
  await running;
  expect((await view(runtime)).status).toBe("cancelled");
  expect(provider.calls()).toBe(1);
});
