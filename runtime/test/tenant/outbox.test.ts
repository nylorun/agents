/**
 * What a commit asks of other components outside the session's wakes, on a real Tenant runtime
 * (on Postgres; architecture §12.3, F7.2): a pod sandbox's reconcile and timer go through the
 * outbox, so a crash between the commit and the send loses neither, and a host revocation goes
 * on the control bus, so it reaches every process with the Tenant open.
 */
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { MemoryExecution } from "../../src/execution/memory.js";
import type { DurableExecution, SandboxSignal } from "../../src/execution/types.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import { fakeSandboxes } from "../support/fake-sandboxes.js";
import { openTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "outbox-app-token-aaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/**
 * Delegates wakes to a memory execution and records the sandbox signals it is handed; with
 * `lose`, every sandbox signal's send fails, as when the process dies after commit.
 */
function sandboxExecution(lose: boolean): DurableExecution & { signals: SandboxSignal[] } {
  const inner = new MemoryExecution({ sweepIntervalMs: 60_000 });
  const signals: SandboxSignal[] = [];
  open.push(() => inner.stop());
  return {
    signals,
    wake: (...args) => inner.wake(...args),
    sandbox: async (_tenantId, _sandboxId, signal) => {
      signals.push(signal);
      if (lose) throw new Error("the send never reached the execution");
    },
    timer: (...args) => inner.timer(...args),
    armSweep: (tenantId) => inner.armSweep(tenantId),
    disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
    start: (handlers) => inner.start(handlers),
    stop: () => inner.stop(),
  };
}

async function boot(
  execution: DurableExecution,
  options: Partial<Parameters<typeof startTestTenant>[0]> = {}
): Promise<Started> {
  const workers = new TenantWorkers();
  await execution.start(workers.handlers);
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
    pods: { client: fakeSandboxes(), harnessImage: "nylorun-runtime:test" },
    execution: { execution, workers },
    ...options,
  });
  open.push(() => runtime.close());
  return runtime;
}

/** The Tenant's outbox rows not yet delivered. */
async function outbox(runtime: Started) {
  const store = await openTestSessionStore(runtime);
  try {
    return await store.tx((t) => t.pendingOutbox(0, 100));
  } finally {
    await store.close();
  }
}

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

it("loses no pod sandbox reconcile or timer to a crash between commit and send: the next process sends them", async () => {
  // Process A creates a pod sandbox, then dies before its signals reach the execution.
  const crashed = sandboxExecution(true);
  const a = await boot(crashed, { retainRoot: true });
  const created = await fetch(`${a.url}/v1/sandboxes/sb1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ kind: "pod" }),
  });
  expect(created.status).toBe(200);
  await until(() => crashed.signals, (signals) => signals.length === 2, "both sends tried");
  const [reconcile, arm] = crashed.signals;
  expect(reconcile).toEqual({ kind: "reconcile", key: expect.stringMatching(/^signal:/) });
  expect(arm).toMatchObject({ kind: "arm", timer: "idle" });
  expect((await outbox(a)).map((row) => row.request)).toEqual([
    { kind: "sandbox", sandboxId: "sb1", signal: reconcile },
    { kind: "sandbox", sandboxId: "sb1", signal: arm },
  ]);
  await a.close();

  // Process B opens the Tenant: its first sweep pass sends both, the reconcile under its key.
  const recorded = sandboxExecution(false);
  const b = await boot(recorded, { hostRoot: a.root, tenantId: a.tenantId });
  try {
    await until(() => recorded.signals, (signals) => signals.length >= 2, "the outbox's signals");
    expect(recorded.signals.slice(0, 2)).toEqual([reconcile, arm]);
    expect(await outbox(b)).toEqual([]);
  } finally {
    await b.close();
    await rm(a.root, { recursive: true, force: true });
  }
});

it("revokes a pod sandbox's host on every process with the Tenant open, not only the one that moved its epoch", async () => {
  const a = await boot(sandboxExecution(false), { retainRoot: true });
  // Process B serves the same Tenant (another API node): the host may be connected there.
  const b = await boot(sandboxExecution(false), { hostRoot: a.root, tenantId: a.tenantId });
  const revoked: { node: string; sandboxId: string; epoch: number }[] = [];
  for (const [node, runtime] of [["a", a], ["b", b]] as const) {
    const server = (runtime.handle as unknown as { ctx: { harness: { revokeHost: Function } } }).ctx.harness;
    server.revokeHost = (sandboxId: string, epoch: number) => revoked.push({ node, sandboxId, epoch });
  }
  const created = await fetch(`${a.url}/v1/sandboxes/sb1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ kind: "pod" }),
  });
  expect(created.status).toBe(200);
  const stopped = await fetch(`${a.url}/v1/sandboxes/sb1/stop`, { method: "POST", headers });
  expect(stopped.status).toBe(200);
  await until(() => revoked, (calls) => calls.length >= 2, "both processes revoked");
  expect(revoked.sort((x, y) => x.node.localeCompare(y.node))).toEqual([
    { node: "a", sandboxId: "sb1", epoch: 1 },
    { node: "b", sandboxId: "sb1", epoch: 1 },
  ]);
  await b.close();
  await a.close();
  await rm(a.root, { recursive: true, force: true });
});
