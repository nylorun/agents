/**
 * Shutdown of an advance (architecture §10.5–10.7, §11.4; `tenant/worker.ts` "Abort reasons")
 * with the in-process execution:
 *
 * - closing a Tenant waits for its advances only for the advance grace period, then abandons
 *   the ones that ignore their abort signal;
 * - a Worker that stops gracefully settles nothing: the turn resumes on the next Worker from
 *   its checkpoint, with the outcomes already recorded, and completes;
 * - a user cancel still settles the turn `cancelled`.
 *
 * The same stop on Restate is in `test/host/shutdown.integration.test.ts`.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../../src/core/provider.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import type { Logger } from "../../src/tenant/types.js";
import { AdvanceAbort, TenantWorkers, abortKind } from "../../src/tenant/worker.js";
import {
  boot,
  cancel,
  controlledModel,
  count,
  openSession,
  sendMessage,
  stored,
  types,
  until,
  view,
  type Started,
} from "../host/execution-support.js";

const open: Started[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
});

function recordingLogger() {
  const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info() {},
    warn: (message, fields) => warnings.push({ message, ...(fields ? { fields } : {}) }),
    error() {},
  };
  return { logger, warnings };
}

/** An in-process execution with its own registry, started, stopped after the test. */
async function worker(graceMs?: number) {
  const execution = new MemoryExecution({ sweepIntervalMs: 60_000 });
  const workers = new TenantWorkers(graceMs === undefined ? {} : { advanceGraceMs: graceMs });
  await execution.start(workers.handlers);
  cleanups.push(() => execution.stop());
  return { execution, workers };
}

describe("abort reasons", () => {
  it("reads a signal's reason as a typed kind; a foreign reason is a shutdown", () => {
    const controller = new AbortController();
    expect(abortKind(controller.signal)).toBeUndefined();
    controller.abort(new AdvanceAbort("cancel", "Turn cancelled"));
    expect(abortKind(controller.signal)).toBe("cancel");
    const stopped = new AbortController();
    stopped.abort(new Error("Worker stopping"));
    expect(abortKind(stopped.signal)).toBe("shutdown");
  });

  it("forwards the execution's abort to the advance as a shutdown", async () => {
    const workers = new TenantWorkers();
    let seen: AbortSignal | undefined;
    workers.register("tenant_a", {
      advance: (_id, signal) => {
        seen = signal;
        return new Promise((resolve) => {
          if (signal.aborted) resolve({ status: "done" });
          else signal.addEventListener("abort", () => resolve({ status: "done" }));
        });
      },
      sweep: async () => {},
    });
    const stopping = new AbortController();
    const result = workers.handlers.advance("tenant_a", "s1", stopping.signal);
    stopping.abort(new Error("Restate attempt ended"));
    await result;
    expect(seen?.reason).toBeInstanceOf(AdvanceAbort);
    expect(seen?.reason).toMatchObject({ kind: "shutdown", message: "Restate attempt ended" });
  });
});

describe("closing a Tenant", () => {
  it("abandons an advance whose effect ignores its abort after the grace period", async () => {
    const model = controlledModel(); // ignores its signal
    cleanups.push(() => model.release());
    const { logger, warnings } = recordingLogger();
    const runtime = await boot({
      modelProvider: model.provider,
      execution: await worker(150),
      workerId: "worker-a",
      logger,
    });
    await openSession(runtime);
    await sendMessage(runtime);
    await model.started;

    const started = Date.now();
    await runtime.close();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(5_000);
    expect(warnings).toContainEqual({
      message: "tenant closed with advances still running",
      fields: { sessionIds: ["s1"], waitedMs: expect.any(Number) },
    });
  });

  it("closes at once when every advance honors its abort", async () => {
    const model = controlledModel({ honorAbort: true });
    cleanups.push(() => model.release());
    const { logger, warnings } = recordingLogger();
    const runtime = await boot({
      modelProvider: model.provider,
      execution: await worker(10_000),
      logger,
    });
    open.push(runtime);
    await openSession(runtime);
    await sendMessage(runtime);
    await model.started;
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(model.aborted).toBe(1);
    expect(warnings.map((w) => w.message)).not.toContain(
      "tenant closed with advances still running"
    );
  });
});

describe("Tenant close", () => {
  it("runs every step when one fails, then rethrows the first error", async () => {
    // Unregistering this Tenant's Worker fails once: the first step of close.
    class FailingWorkers extends TenantWorkers {
      override register(...args: Parameters<TenantWorkers["register"]>): () => void {
        const unregister = super.register(...args);
        let failed = false;
        return () => {
          unregister();
          if (failed) return;
          failed = true;
          throw new Error("unregister failed");
        };
      }
    }
    const execution = new MemoryExecution({ sweepIntervalMs: 60_000 });
    const workers = new FailingWorkers();
    await execution.start(workers.handlers);
    cleanups.push(() => execution.stop());
    const { logger, warnings } = recordingLogger();
    const runtime = await boot({ execution: { execution, workers }, logger });
    open.push(runtime);

    await expect(runtime.handle.close()).rejects.toThrow("unregister failed");
    expect(warnings).toContainEqual({
      message: "tenant close step failed",
      fields: { step: "detach", message: "unregister failed" },
    });
    // The last step still ran: the store is closed.
    await expect(runtime.handle.summary()).rejects.toThrow(/closed/i);
  });
});

describe("graceful Worker stop", () => {
  it("leaves the turn to the next Worker, which resumes it from the recorded outcome", async () => {
    const streams = new MemoryStreams();
    cleanups.push(() => streams.close());
    const a = await worker();
    let calls = 0;
    // The Worker stops while the model answers: the answer is recorded, the turn is not settled.
    const stopping: ModelProvider = async () => {
      calls += 1;
      void a.execution.stop();
      return { output: [{ type: "text", text: "answer from worker A" }] };
    };
    const runtimeA = await boot({
      modelProvider: stopping,
      execution: a,
      workerId: "worker-a",
      streams,
      retainRoot: true,
    });
    cleanups.push(() => rm(runtimeA.root, { recursive: true, force: true }));
    await openSession(runtimeA);
    await sendMessage(runtimeA);
    await until(() => stored(runtimeA), (s) => s.effects.length === 1, "the model outcome");
    await a.execution.stop();

    const left = await stored(runtimeA);
    expect(left.session).toMatchObject({ status: "running", owner: null });
    expect(left.effects.map((effect) => effect.status)).toEqual(["completed"]);
    const before = await types(runtimeA);
    for (const settled of ["turn.cancelled", "turn.failed", "turn.completed", "effect.uncertain"])
      expect(before).not.toContain(settled);
    await runtimeA.close();

    // The next Worker (a new process: new Worker id) finds the session through its sweep.
    const runtimeB = await boot({
      hostRoot: runtimeA.root,
      tenantId: runtimeA.tenantId,
      modelProvider: async () => {
        calls += 1;
        return { output: [{ type: "text", text: "answer from worker B" }] };
      },
      execution: await worker(),
      workerId: "worker-b",
      streams,
    });
    open.push(runtimeB);
    await until(() => view(runtimeB), (v) => v.status === "completed", "completed");
    expect(calls).toBe(1);
    const events = await types(runtimeB);
    expect(count(events, "turn.completed")).toBe(1);
    expect(events).not.toContain("turn.cancelled");
    expect(events).not.toContain("turn.failed");
    const items = (await (
      await fetch(`${runtimeB.url}/v1/sessions/s1/items`, { headers: runtimeB.headers() })
    ).json()) as { items: { type: string; payload?: { output?: unknown } }[] };
    expect(
      JSON.stringify(items.items.find((item) => item.type === "turn.completed")?.payload)
    ).toContain("answer from worker A");
    expect((await stored(runtimeB)).session.owner).toBeNull();
  });

  it("still settles a user cancel as cancelled", async () => {
    const model = controlledModel({ honorAbort: true });
    cleanups.push(() => model.release());
    const runtime = await boot({ modelProvider: model.provider, execution: await worker() });
    open.push(runtime);
    await openSession(runtime);
    await sendMessage(runtime);
    await model.started;
    await cancel(runtime);
    await until(() => stored(runtime), (s) => s.session.owner === null, "released");
    expect((await view(runtime)).status).toBe("cancelled");
    expect(model.aborted).toBe(1);
    expect(await types(runtime)).toContain("turn.cancelled");
  });
});
