/**
 * The Host's Durable Session Execution (`host/execution.ts`) with the in-process execution:
 * roles, sweep arming, the Tenant status hook, and the advance deadline (`tenant/worker.ts`).
 * The same wiring against Restate is in `execution.integration.test.ts`.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { TenantStatusSchema } from "@nylorun/core/contracts";
import { MemoryExecution } from "../../src/execution/memory.js";
import type {
  AdvanceResult,
  DurableExecution,
  StuckInvocation,
  WorkerHandlers,
} from "../../src/execution/types.js";
import { createHostExecution, type HostExecution } from "../../src/host/execution.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import {
  AdvanceDeadlineError,
  TenantWorkers,
  type TenantWorker,
} from "../../src/tenant/worker.js";
import {
  boot,
  controlledModel,
  count,
  openSession,
  sendMessage,
  server,
  stored,
  types,
  until,
  view,
  type Started,
} from "./execution-support.js";

const open: Started[] = [];
const hosts: HostExecution[] = [];
const cleanups: (() => void)[] = [];
/** Host roots kept across a Tenant restart, removed after everything closed. */
const roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A DurableExecution that records calls and can be told to fail arming. */
function recordingExecution(
  extra: Partial<DurableExecution> = {}
): DurableExecution & { calls: string[]; failArm: Set<string> } {
  const calls: string[] = [];
  const failArm = new Set<string>();
  return {
    calls,
    failArm,
    wake: async () => {},
    timer: async () => {},
    armSweep: async (tenantId) => {
      calls.push(`arm:${tenantId}`);
      if (failArm.has(tenantId)) throw new Error(`arm ${tenantId} failed`);
    },
    disarmSweep: async (tenantId) => {
      calls.push(`disarm:${tenantId}`);
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    ...extra,
  };
}

function host(
  options: Partial<Parameters<typeof createHostExecution>[0]> &
    Pick<Parameters<typeof createHostExecution>[0], "execution">
): HostExecution {
  const created = createHostExecution({
    role: "all",
    resolve: async () => undefined,
    ...options,
  });
  hosts.push(created);
  return created;
}

describe("createHostExecution roles", () => {
  it("never starts the Worker for the api role", async () => {
    const execution = recordingExecution();
    const api = host({ execution, role: "api" });
    await api.start();
    await api.stop();
    expect(execution.calls).toEqual([]);
  });

  it.each(["worker", "all"] as const)(
    "starts the Worker once for the %s role and stops it once",
    async (role) => {
      const execution = recordingExecution();
      const worker = host({ execution, role });
      await Promise.all([worker.start(), worker.start()]);
      await worker.start();
      await Promise.all([worker.stop(), worker.stop()]);
      expect(execution.calls).toEqual(["start", "stop"]);
    }
  );

  it("lets start be retried after it fails", async () => {
    let attempts = 0;
    const execution = recordingExecution({
      start: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("registration failed");
      },
    });
    const worker = host({ execution });
    await expect(worker.start()).rejects.toThrow("registration failed");
    await worker.start();
    expect(attempts).toBe(2);
  });

  it("delivers wakes to Tenants only on a process that serves the Worker", async () => {
    const advanced: string[] = [];
    const worker: TenantWorker = {
      advance: async (sessionId) => {
        advanced.push(sessionId);
        return { status: "done" };
      },
      sweep: async () => {},
    };
    const apiExecution = new MemoryExecution();
    const api = host({ execution: apiExecution, role: "api", resolve: async () => worker });
    await api.start();
    await api.tenantExecution.execution.wake("tenant_a", "s1", { reason: "message" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(advanced).toEqual([]);
    await apiExecution.stop();

    const all = host({
      execution: new MemoryExecution(),
      role: "all",
      resolve: async () => worker,
    });
    await all.start();
    await all.tenantExecution.execution.wake("tenant_a", "s2", { reason: "message" });
    await until(async () => advanced, (list) => list.includes("s2"), "advance");
  });

  it("dispatches to registered Tenants and resolves the others on demand", async () => {
    const calls: string[] = [];
    const workerFor = (name: string): TenantWorker => ({
      advance: async (sessionId) => {
        calls.push(`${name}:advance:${sessionId}`);
        return { status: "done" };
      },
      sweep: async () => {
        calls.push(`${name}:sweep`);
      },
    });
    const created = host({
      execution: recordingExecution(),
      resolve: async (tenantId) =>
        tenantId === "tenant_b" ? workerFor("resolved") : undefined,
    });
    const { workers } = created.tenantExecution;
    workers.register("tenant_a", workerFor("registered"));
    const signal = new AbortController().signal;
    await workers.handlers.advance("tenant_a", "s1", signal);
    await workers.handlers.advance("tenant_b", "s2", signal);
    expect(await workers.handlers.advance("tenant_c", "s3", signal)).toEqual({
      status: "done",
    });
    await workers.handlers.sweep("tenant_b");
    expect(calls).toEqual([
      "registered:advance:s1",
      "resolved:advance:s2",
      "resolved:sweep",
    ]);
  });
});

describe("createHostExecution sweeps", () => {
  it("arms every Tenant once, whatever the role", async () => {
    const execution = recordingExecution();
    const api = host({ execution, role: "api" });
    await api.armAll(["tenant_a", "tenant_b", "tenant_a"]);
    await api.armAll([]);
    expect(execution.calls.sort()).toEqual(["arm:tenant_a", "arm:tenant_b"]);
  });

  it("tries every Tenant and reports the ones that failed", async () => {
    const execution = recordingExecution();
    execution.failArm.add("tenant_b");
    const warnings: unknown[] = [];
    const created = host({
      execution,
      logger: { info() {}, warn: (_m, fields) => warnings.push(fields), error() {} },
    });
    const ids = Array.from({ length: 40 }, (_, i) => `tenant_${i}`);
    const armed = created.armAll([...ids, "tenant_b"]);
    await expect(armed).rejects.toBeInstanceOf(AggregateError);
    await expect(armed).rejects.toMatchObject({ errors: [expect.any(Error)] });
    expect(execution.calls.filter((call) => call.startsWith("arm:"))).toHaveLength(41);
    expect(warnings).toEqual([expect.objectContaining({ tenantId: "tenant_b" })]);
  });

  it("disarms a deleted Tenant", async () => {
    const execution = recordingExecution();
    await host({ execution }).disarm("tenant_a");
    expect(execution.calls).toEqual(["disarm:tenant_a"]);
  });

  it("re-arms a Tenant's sweep at startup, which opens it and re-wakes a runnable session", async () => {
    // A Tenant left a runnable session behind whose wake was lost: its execution never ran.
    const model = controlledModel();
    model.release();
    const lost = { execution: new MemoryExecution(), workers: new TenantWorkers() };
    const first = await boot({
      modelProvider: model.provider,
      execution: lost,
      retainRoot: true,
    });
    roots.push(first.root);
    await openSession(first);
    await sendMessage(first);
    expect((await view(first)).status).toBe("runnable");
    await first.close();

    // The next process knows the Tenant but does not open it until an invocation arrives.
    let opened: Started | undefined;
    const execution = new MemoryExecution({ sweepIntervalMs: 60_000 });
    const next = host({
      execution,
      resolve: async (tenantId) => {
        expect(tenantId).toBe(first.tenantId);
        if (!opened) {
          opened = await boot({
            hostRoot: first.root,
            tenantId,
            modelProvider: model.provider,
            execution: next.tenantExecution,
          });
          open.push(opened);
        }
        return (opened.handle as TenantRuntime).worker;
      },
    });
    await next.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toBeUndefined();
    await next.armAll([first.tenantId]);
    await until(async () => opened && (await view(opened)).status, (s) => s === "completed", "completed");
    expect(count(await types(opened!), "turn.completed")).toBe(1);
  });
});

describe("Tenant status", () => {
  it("reports the Tenant's stuck invocations from the Host execution", async () => {
    const stuck: StuckInvocation[] = [
      {
        id: "inv_1",
        status: "paused",
        service: "NylorunSession",
        handler: "advance",
        key: "tenant:s1",
        tenantId: "tenant",
        retryCount: 3,
        lastFailure: "[500] boom",
      },
    ];
    const asked: string[] = [];
    const created = host({
      execution: Object.assign(new MemoryExecution(), {
        stuckInvocations: async (tenantId: string) => {
          asked.push(tenantId);
          return stuck;
        },
      }),
    });
    const runtime = await boot({ execution: created.tenantExecution });
    open.push(runtime);
    const status = TenantStatusSchema.parse(
      await (await fetch(`${runtime.url}/v1/tenant`, { headers: server })).json()
    );
    expect(asked).toEqual([runtime.tenantId]);
    expect(status.execution).toEqual({
      stuckInvocations: [
        {
          id: "inv_1",
          status: "paused",
          service: "NylorunSession",
          handler: "advance",
          key: "tenant:s1",
          retryCount: 3,
          lastFailure: "[500] boom",
        },
      ],
    });
  });

  it("reports why stuck invocations are unknown instead of failing", async () => {
    const created = host({
      execution: Object.assign(new MemoryExecution(), {
        stuckInvocations: async () => {
          throw new Error("admin API unreachable");
        },
      }),
    });
    const runtime = await boot({ execution: created.tenantExecution });
    open.push(runtime);
    const response = await fetch(`${runtime.url}/v1/tenant`, { headers: server });
    expect(response.status).toBe(200);
    expect(TenantStatusSchema.parse(await response.json()).execution).toEqual({
      stuckInvocations: [],
      error: "admin API unreachable",
    });
  });

  it("omits execution when the execution cannot report stuck invocations", async () => {
    const runtime = await boot({});
    open.push(runtime);
    const status = TenantStatusSchema.parse(
      await (await fetch(`${runtime.url}/v1/tenant`, { headers: server })).json()
    );
    expect(status.execution).toBeUndefined();
  });
});

describe("advance deadline", () => {
  const worker = (
    advance: (signal: AbortSignal) => Promise<AdvanceResult>
  ): TenantWorker => ({ advance: (_id, signal) => advance(signal), sweep: async () => {} });

  it("aborts the advance's signal at the deadline", async () => {
    const workers = new TenantWorkers({ advanceDeadlineMs: 30, advanceGraceMs: 1000 });
    let reason: unknown;
    workers.register(
      "tenant_a",
      worker(
        (signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              reason = signal.reason;
              resolve({ status: "done" });
            })
          )
      )
    );
    expect(
      await workers.handlers.advance("tenant_a", "s1", new AbortController().signal)
    ).toEqual({ status: "done" });
    expect(reason).toBeInstanceOf(AdvanceDeadlineError);
  });

  it("forwards the execution's abort and abandons an advance that ignores it", async () => {
    const warnings: unknown[] = [];
    const workers = new TenantWorkers({
      advanceGraceMs: 30,
      logger: { info() {}, warn: (_m, fields) => warnings.push(fields), error() {} },
    });
    let seen: AbortSignal | undefined;
    workers.register(
      "tenant_a",
      worker((signal) => {
        seen = signal;
        return new Promise(() => {});
      })
    );
    const stopping = new AbortController();
    const result = workers.handlers.advance("tenant_a", "s1", stopping.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopping.abort(new Error("Worker stopping"));
    expect(await result).toEqual({ status: "busy", retryAfterMs: 0 });
    expect(seen?.reason).toMatchObject({ kind: "shutdown", message: "Worker stopping" });
    expect(warnings).toEqual([
      expect.objectContaining({ tenantId: "tenant_a", sessionId: "s1", reason: "Worker stopping" }),
    ]);
  });

  it("rejects a deadline setTimeout cannot keep", () => {
    expect(() => new TenantWorkers({ advanceDeadlineMs: 0 })).toThrow("advanceDeadlineMs");
    expect(() => new TenantWorkers({ advanceDeadlineMs: 2 ** 31 })).toThrow("advanceDeadlineMs");
    expect(() => new TenantWorkers({ advanceGraceMs: Number.NaN })).toThrow("advanceGraceMs");
  });

  it("settles a runaway model call as uncertain at the deadline", async () => {
    const model = controlledModel({ honorAbort: true });
    const created = host({
      execution: new MemoryExecution({ sweepIntervalMs: 60_000 }),
      advanceDeadlineMs: 200,
    });
    const runtime = await boot({
      modelProvider: model.provider,
      execution: created.tenantExecution,
      workerId: "worker-a",
    });
    open.push(runtime);
    await created.start();
    await openSession(runtime);
    await sendMessage(runtime);
    await model.started;
    await until(() => view(runtime), (v) => v.status === "uncertain", "uncertain");
    expect(model.aborted).toBe(1);
    expect(count(await types(runtime), "effect.uncertain")).toBe(1);
    const { session, effects } = await stored(runtime);
    expect(session.owner).toBeNull();
    expect(effects.map((effect) => effect.status)).toEqual(["uncertain"]);
  });

  it("abandons an advance that ignores the deadline; the next advance takes over", async () => {
    const model = controlledModel();
    const workers = new TenantWorkers({ advanceDeadlineMs: 100, advanceGraceMs: 50 });
    const execution = new MemoryExecution({ sweepIntervalMs: 60_000 });
    const runtime = await boot({
      modelProvider: model.provider,
      execution: { execution, workers },
      workerId: "worker-a",
      ownerLeaseMs: 300,
    });
    open.push(runtime);
    cleanups.push(() => model.release());
    const results: AdvanceResult[] = [];
    const counting: WorkerHandlers = {
      ...workers.handlers,
      advance: async (...args) => {
        const result = await workers.handlers.advance(...args);
        results.push(result);
        return result;
      },
    };
    await execution.start(counting);
    await openSession(runtime);
    await sendMessage(runtime);
    await model.started;

    // Abandoned at 150 ms; busy until the lease the heartbeat stopped renewing lapses; then
    // taken over: the in-flight effect becomes uncertain.
    await until(() => view(runtime), (v) => v.status === "uncertain", "uncertain", 5000);
    expect(results[0]).toEqual({ status: "busy", retryAfterMs: 0 });
    expect(count(await types(runtime), "effect.uncertain")).toBe(1);

    // The abandoned call returns: its epoch is gone, so it records nothing.
    model.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await types(runtime);
    expect(events).not.toContain("turn.completed");
    expect(count(events, "effect.uncertain")).toBe(1);
    expect(model.calls).toBe(1);
    const { session, effects } = await stored(runtime);
    expect(session).toMatchObject({ status: "uncertain", owner: null });
    expect(effects.map((effect) => effect.status)).toEqual(["uncertain"]);
    await execution.stop();
  });
});
