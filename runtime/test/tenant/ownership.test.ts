/**
 * Ownership and the Durable Execution seam on a real Tenant runtime (on Postgres; architecture
 * §10.5–10.6, §11.4, §17): racing advances, takeover, stale owners, duplicate wakes, and
 * wakes whose send failed or was cut off after commit, delivered from the wake outbox.
 */
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import type { DurableExecution, Wake } from "../../src/execution/types.js";
import { openTestSessionStore } from "../support/store.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import { TenantWorkers, type TenantExecution } from "../../src/tenant/worker.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "ownership-app-token-aaaaaaaaaaaa";
const server = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: Started[] = [];
afterEach(async () => {
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
});

const plain = Agent({ id: "bot", name: "Bot" }).build();

/** A model call that waits for `release()`; counts calls. */
function gatedModel() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const model = {
    calls: 0,
    started,
    release: () => release(),
    provider: (async () => {
      model.calls += 1;
      entered();
      await gate;
      return { output: [{ type: "text", text: "done" }] };
    }) as ModelProvider,
  };
  return model;
}

/** An execution the test drives: wakes queue until `start`. */
function hostExecution(): TenantExecution & { execution: MemoryExecution } {
  return { execution: new MemoryExecution(), workers: new TenantWorkers() };
}

async function boot(options: Parameters<typeof startTestTenant>[0]) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    ...options,
  });
  open.push(runtime);
  return runtime;
}

const workerOf = (runtime: Started) =>
  (runtime.handle as TenantRuntime).worker;

async function openTurn(
  runtime: Started,
  manifest: unknown,
  id = "s1",
  register = true
) {
  if (register) {
    const put = await fetch(`${runtime.url}/v1/agents/bot`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify({
        requestId: "put-1",
        manifest,
        implementationVersion: "dev",
      }),
    });
    expect(put.ok).toBe(true);
  }
  const session = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: server,
    body: JSON.stringify({
      requestId: `session-${id}`,
      agentId: "bot",
      ownerUserId: "u",
    }),
  });
  expect(session.ok).toBe(true);
  const message = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({
      type: "message",
      requestId: `msg-${id}`,
      idempotencyKey: `msg-${id}`,
      content: "hello",
    }),
  });
  expect(message.ok).toBe(true);
}

async function view(runtime: Started, id = "s1") {
  return (await (
    await fetch(`${runtime.url}/v1/sessions/${id}`, { headers: server })
  ).json()) as { status: string };
}

async function types(runtime: Started, id = "s1") {
  const body = (await (
    await fetch(`${runtime.url}/v1/sessions/${id}/items`, { headers: server })
  ).json()) as { items: { type: string }[] };
  return body.items.map((item) => item.type);
}

async function until<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  what: string
): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await probe();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const count = (list: string[], type: string) =>
  list.filter((item) => item === type).length;

it("runs one of two racing advances; the other is busy, and no event is duplicated", async () => {
  const model = gatedModel();
  const host = hostExecution(); // never started: only the test advances
  const runtime = await boot({
    modelProvider: model.provider,
    execution: host,
    ownerLeaseMs: 60_000,
  });
  await openTurn(runtime, plain.manifest);
  const worker = workerOf(runtime);
  const signal = new AbortController().signal;
  // Either may take ownership first: the other answers busy at once, the winner runs.
  const racing = [worker.advance("s1", signal), worker.advance("s1", signal)];
  const busy = await Promise.race(racing);
  expect(busy.status).toBe("busy");
  const settled = await Promise.race(
    racing.map((advance, i) => advance.then((result) => ({ i, result })))
  );
  const first = racing[1 - settled.i]!;
  if (busy.status === "busy") {
    expect(busy.retryAfterMs).toBeGreaterThan(0);
    expect(busy.retryAfterMs).toBeLessThanOrEqual(60_000);
  }
  await model.started;
  // A third advance while the first runs is busy too.
  expect((await worker.advance("s1", signal)).status).toBe("busy");
  model.release();
  expect(await first).toEqual({ status: "done" });
  expect((await view(runtime)).status).toBe("completed");
  const events = await types(runtime);
  expect(count(events, "turn.completed")).toBe(1);
  expect(model.calls).toBe(1);
  // Ownership was released: a later advance takes it and finds nothing to run.
  expect(await worker.advance("s1", signal)).toEqual({ status: "done" });
});

it("keeps a second Worker on the same Tenant out while the first owns the session", async () => {
  const model = gatedModel();
  const a = await boot({
    modelProvider: model.provider,
    execution: hostExecution(),
    workerId: "worker-a",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
    retainRoot: true,
  });
  await openTurn(a, plain.manifest);
  const running = workerOf(a).advance("s1", new AbortController().signal);
  await model.started;
  const b = await boot({
    hostRoot: a.root,
    tenantId: a.tenantId,
    applicationKey: APP,
    modelProvider: model.provider,
    execution: hostExecution(),
    workerId: "worker-b",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
    retainRoot: true,
  });
  expect(
    (await workerOf(b).advance("s1", new AbortController().signal)).status
  ).toBe("busy");
  model.release();
  expect(await running).toEqual({ status: "done" });
  expect(count(await types(a), "turn.completed")).toBe(1);
  expect(model.calls).toBe(1);
});

it("takes over from a dead owner: invoking effects become uncertain and the stale owner writes nothing", async () => {
  const model = gatedModel();
  const runtime = await boot({
    modelProvider: model.provider,
    execution: hostExecution(),
    workerId: "worker-a",
    ownerLeaseMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  await openTurn(runtime, plain.manifest);
  const worker = workerOf(runtime);
  const stale = worker.advance("s1", new AbortController().signal);
  await model.started; // the model effect is `invoking` under worker-a

  // Another Worker took the session over and then died too: its lease already expired.
  const other = await openTestSessionStore(runtime);
  try {
    const taken = await other.tx((t) =>
      t.takeOwnership("s1", {
        owner: "worker-dead",
        now: new Date(Date.now() + 120_000),
        leaseMs: -240_000,
      })
    );
    expect(taken).toMatchObject({ status: "owned", takeover: true });
  } finally {
    await other.close();
  }

  // The next advance takes over from worker-dead.
  expect(
    await worker.advance("s1", new AbortController().signal)
  ).toEqual({ status: "done" });
  expect((await view(runtime)).status).toBe("uncertain");
  let events = await types(runtime);
  expect(count(events, "effect.uncertain")).toBe(1);

  // worker-a's model call returns: its epoch is gone, so it records nothing.
  model.release();
  expect(await stale).toEqual({ status: "done" });
  events = await types(runtime);
  expect(events).not.toContain("turn.completed");
  expect(events).not.toContain("turn.failed");
  expect(count(events, "effect.uncertain")).toBe(1);
  expect((await view(runtime)).status).toBe("uncertain");
  expect(model.calls).toBe(1);

  const check = await openTestSessionStore(runtime);
  try {
    const effects = await check.tx((t) =>
      t.effectsForSession("s1", { statuses: ["uncertain", "completed"] })
    );
    expect(effects.map((effect) => effect.status)).toEqual(["uncertain"]);
    const session = await check.tx((t) => t.get("sessions", "s1"));
    expect(session).toMatchObject({ owner: null });
  } finally {
    await check.close();
  }
});

it("treats duplicate wakes as harmless", async () => {
  const model = gatedModel();
  const host = hostExecution();
  const runtime = await boot({ modelProvider: model.provider, execution: host });
  await host.execution.start(host.workers.handlers);
  await openTurn(runtime, plain.manifest);
  await model.started;
  const tenantId = runtime.tenantId;
  const wakes: Wake[] = [
    { reason: "recover" },
    { reason: "recover" },
    { reason: "message", dedupeKey: "same" },
    { reason: "message", dedupeKey: "same" },
    { reason: "linked" },
  ];
  for (const wake of wakes) await host.execution.wake(tenantId, "s1", wake);
  model.release();
  await until(() => view(runtime), (v) => v.status === "completed", "completed");
  for (const wake of wakes) await host.execution.wake(tenantId, "s1", wake);
  await host.execution.idle();
  const events = await types(runtime);
  expect(count(events, "turn.completed")).toBe(1);
  expect(count(events, "turn.started")).toBeLessThanOrEqual(1);
  expect(model.calls).toBe(1);
});

/**
 * Delegates to `inner`, except that `lose` picks wakes whose send fails, as when the process
 * dies after commit or Restate is unreachable. Records every wake it is handed.
 */
function lossyExecution(
  inner: MemoryExecution,
  lose: (wake: Wake) => boolean
): DurableExecution & { handed: Wake[]; lost: Wake[] } {
  const handed: Wake[] = [];
  const lost: Wake[] = [];
  return {
    handed,
    lost,
    wake: async (tenantId, sessionId, wake) => {
      handed.push(wake);
      if (lose(wake)) {
        lost.push(wake);
        throw new Error("the send never reached the execution");
      }
      await inner.wake(tenantId, sessionId, wake);
    },
    timer: (...args) => inner.timer(...args),
    armSweep: (tenantId) => inner.armSweep(tenantId),
    disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
    start: (handlers) => inner.start(handlers),
    stop: () => inner.stop(),
  };
}

/** The Tenant's wake outbox rows not yet delivered. */
async function outbox(runtime: Started) {
  const store = await openTestSessionStore(runtime);
  try {
    return await store.tx((t) => t.pendingWakes(new Date(Date.now() + 60_000), 100));
  } finally {
    await store.close();
  }
}

it("delivers a wake whose send failed after commit from the outbox, with its dedupe key", async () => {
  const inner = new MemoryExecution({ sweepIntervalMs: 30 });
  // The message's wake fails once: the commit stands and its outbox row stays.
  let failed = false;
  const lossy = lossyExecution(inner, (wake) => {
    if (wake.reason !== "message" || failed) return false;
    failed = true;
    return true;
  });
  const workers = new TenantWorkers();
  await lossy.start(workers.handlers);
  const runtime = await boot({
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
    execution: { execution: lossy, workers },
  });
  try {
    await openTurn(runtime, plain.manifest);
    expect(lossy.lost).toHaveLength(1);
    expect(lossy.lost[0]!.dedupeKey).toMatch(/^message:/);
    expect((await outbox(runtime)).map((row) => row.wake)).toEqual(lossy.lost);
    // The sweep sends it again once it is `WAKE_GRACE_MS` old, under the same key.
    await until(() => view(runtime), (v) => v.status === "completed", "completed");
    const sent = lossy.handed.filter((wake) => wake.reason === "message");
    expect(sent).toEqual([lossy.lost[0], lossy.lost[0]]);
    expect(count(await types(runtime), "turn.completed")).toBe(1);
    expect(await outbox(runtime)).toEqual([]);
  } finally {
    await runtime.close();
    await inner.stop();
  }
});

it("loses no wake to a crash between commit and send: the next process delivers it from the outbox", async () => {
  // Process A commits the message, then dies before the wake reaches the execution.
  const innerA = new MemoryExecution({ sweepIntervalMs: 60_000 });
  const crashed = lossyExecution(innerA, (wake) => wake.reason === "message");
  const workersA = new TenantWorkers();
  await crashed.start(workersA.handlers);
  let calls = 0;
  const model: ModelProvider = async () => {
    calls += 1;
    return { output: [{ type: "text", text: "done" }] };
  };
  const a = await boot({
    modelProvider: model,
    execution: { execution: crashed, workers: workersA },
    retainRoot: true,
  });
  await openTurn(a, plain.manifest);
  expect(crashed.lost).toHaveLength(1);
  expect(await outbox(a)).toMatchObject([{ sessionId: "s1", wake: crashed.lost[0] }]);
  await a.close();
  await innerA.stop();

  // Process B opens the Tenant: its first sweep pass hands the outbox's wake over, same key.
  const innerB = new MemoryExecution({ sweepIntervalMs: 60_000 });
  const recorded = lossyExecution(innerB, () => false);
  const workersB = new TenantWorkers();
  await recorded.start(workersB.handlers);
  const b = await boot({
    hostRoot: a.root,
    tenantId: a.tenantId,
    modelProvider: model,
    execution: { execution: recorded, workers: workersB },
  });
  try {
    await until(() => view(b), (v) => v.status === "completed", "completed");
    expect(recorded.handed).toContainEqual(crashed.lost[0]);
    expect(count(await types(b), "turn.completed")).toBe(1);
    expect(calls).toBe(1);
    expect(await outbox(b)).toEqual([]);
  } finally {
    await b.close();
    await innerB.stop();
    await rm(a.root, { recursive: true, force: true });
  }
});
