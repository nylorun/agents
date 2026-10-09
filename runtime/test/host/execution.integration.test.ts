/**
 * The Host's Durable Session Execution on a real Restate server (the Docker test stack), with
 * real Tenant runtimes on the test store (architecture §10.5–10.7, §11.4, §12.3, §14.8, §17).
 *
 * Worker endpoints are served on the host and advertised to Restate, which runs in Docker, as
 * `http://host.docker.internal:<port>`. Every Host execution uses a service prefix unique to
 * the run, so runs sharing one Restate server never take each other's invocations; a fresh
 * prefix is also how a test simulates losing Restate's state.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { TenantStatusSchema } from "@nylorun/core/contracts";
import {
  createRestateExecution,
  type RestateExecutionOptions,
} from "../../src/adapters/execution/restate.js";
import type {
  AdvanceResult,
  DurableExecution,
  WorkerHandlers,
} from "../../src/execution/types.js";
import { createHostExecution, type HostExecution } from "../../src/host/execution.js";
import { openTestSessionStore } from "../support/store.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import type { TenantRuntime } from "../../src/tenant/runtime.js";
import type { RuntimeServices } from "../../src/host/stack-config.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import {
  boot,
  cancel,
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

/** Worker ports for this file (9200–9219 by default); each test takes its own. */
const PORT_BASE = Number(process.env.NYLORUN_TEST_HOST_WORKER_PORT_BASE ?? 9200);
/** Where Restate (in Docker) reaches the host. */
const WORKER_HOST_NAME = process.env.NYLORUN_TEST_WORKER_HOST ?? "host.docker.internal";
const RUN = `h${randomUUID().replaceAll("-", "").slice(0, 10)}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function restateOptions(
  offset: number,
  prefix: string,
  extra: Partial<RestateExecutionOptions> = {}
): RestateExecutionOptions {
  const endpoints = stackEndpoints();
  const port = PORT_BASE + offset;
  return {
    ingressUrl: endpoints.restate.ingressUrl,
    adminUrl: endpoints.restate.adminUrl,
    // 0.0.0.0: on Linux, host-gateway reaches the host on the bridge address.
    workerListen: { host: "0.0.0.0", port },
    workerAdvertisedUrl: `http://${WORKER_HOST_NAME}:${port}`,
    servicePrefix: `${RUN}_${prefix}_`,
    sweepIntervalMs: 200,
    retry: { initialIntervalMs: 50, maxIntervalMs: 500 },
    registrationTimeoutMs: 30_000,
    logger: () => {},
    ...extra,
  };
}

/** Sends a wake through `inner` (`DurableExecution.wake`), for fault injection. */
type WakeSend = (
  inner: DurableExecution,
  ...args: Parameters<DurableExecution["wake"]>
) => Promise<void>;

type Recording = DurableExecution & { results: AdvanceResult[]; sweeps: number };

/**
 * Delegates to `inner`, recording every advance result the Worker returns and counting sweep
 * passes. `wake` replaces how a wake is sent.
 */
function recording(
  inner: DurableExecution,
  wake: WakeSend = (execution, ...args) => execution.wake(...args)
): Recording {
  const results: AdvanceResult[] = [];
  const recorder: Recording = {
    results,
    sweeps: 0,
    wake: (...args) => wake(inner, ...args),
    timer: (...args) => inner.timer(...args),
    armSweep: (tenantId) => inner.armSweep(tenantId),
    disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
    stop: () => inner.stop(),
    stuckInvocations: (tenantId) => inner.stuckInvocations!(tenantId),
    start: (handlers: WorkerHandlers) =>
      inner.start({
        ...handlers,
        advance: async (...args) => {
          const result = await handlers.advance(...args);
          results.push(result);
          return result;
        },
        sweep: async (tenantId) => {
          await handlers.sweep(tenantId);
          recorder.sweeps += 1;
        },
      }),
  };
  return recorder;
}

const open: Started[] = [];
const hosts: HostExecution[] = [];
/** Run before the Hosts stop (releasing models). */
const cleanups: (() => Promise<void> | void)[] = [];
/** Run after the Tenants close (shared streams, retained Host roots). */
const finally_: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => undefined);
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
  for (const cleanup of finally_.splice(0).reverse()) await cleanup();
});

function hostExecution(input: {
  offset: number;
  prefix: string;
  services?: RuntimeServices;
  restate?: Partial<RestateExecutionOptions>;
  resolve?: (tenantId: string) => Promise<TenantRuntime["worker"] | undefined>;
  advanceGraceMs?: number;
  wake?: WakeSend;
}) {
  const execution = recording(
    createRestateExecution(restateOptions(input.offset, input.prefix, input.restate)),
    input.wake
  );
  const host = createHostExecution({
    execution,
    services: input.services ?? new Set(["core", "loop"] as const),
    resolve: input.resolve ?? (async () => undefined),
    ...(input.advanceGraceMs !== undefined ? { advanceGraceMs: input.advanceGraceMs } : {}),
  });
  hosts.push(host);
  return { host, execution };
}

async function tenant(options: Parameters<typeof boot>[0]): Promise<Started> {
  const runtime = await boot({ sweepIntervalMs: 200, ...options });
  open.push(runtime);
  return runtime;
}

describe.skipIf(!STACK_ENABLED)("Host execution on Restate", () => {
  it("completes a message turn with a scripted model through Restate", async () => {
    const { host, execution } = hostExecution({ offset: 0, prefix: "turn" });
    // The Worker registers the services before any Tenant arms its sweep through the ingress.
    await host.start();
    const runtime = await tenant({ execution: host.tenantExecution });
    await openSession(runtime);
    await sendMessage(runtime);
    await until(() => view(runtime), (v) => v.status === "completed", "completed", 20_000);
    expect(count(await types(runtime), "turn.completed")).toBe(1);
    // The advance writes the turn before it returns its result.
    await until(async () => execution.results, (r) => r.length > 0, "the advance to end");
    expect(execution.results).toContainEqual({ status: "done" });
    expect((await stored(runtime)).session.owner).toBeNull();
  });

  it("rolls a long turn over into new segments through Restate (Model Calls §10)", async () => {
    const { host, execution } = hostExecution({ offset: 10, prefix: "rollover" });
    await host.start();
    let calls = 0;
    const runtime = await tenant({
      execution: host.tenantExecution,
      sandbox: { backend: "virtual" },
      rollover: { steps: 2 },
      modelProvider: async (effect) => {
        const step = calls++;
        if (step >= 7) return { output: [{ type: "text", text: "done" }] };
        return {
          output: [
            {
              type: "tool-call",
              id: `call-${effect.turnId}-${step}`,
              name: "write",
              args: { path: `f${step}.txt`, content: "x" },
            },
          ],
        };
      },
    });
    await openSession(runtime, "s1", true);
    // A second session with a sandbox, so the model's writes run in the Runtime.
    const opened = await fetch(`${runtime.url}/v1/sessions/long`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify({ requestId: "session-long", agentId: "bot", ownerUserId: "u", sandbox: {} }),
    });
    expect(opened.ok).toBe(true);
    await sendMessage(runtime, "long");
    await until(() => view(runtime, "long"), (v) => v.status === "completed", "completed", 30_000);
    expect(calls).toBe(8);
    const events = await types(runtime, "long");
    expect(count(events, "turn.completed")).toBe(1);
    expect(count(events, "turn.paused")).toBe(0);
    // 8 model calls at 2 steps per segment: segments 0–3, each its own advance.
    expect(((await stored(runtime, "long")).session as any).checkpoint.segment).toBe(3);
    await until(
      async () => execution.results,
      (r) => r.filter((result) => result.status === "done").length >= 4,
      "an advance per segment"
    );
  });
  it("re-wakes a busy session through Restate once the other Worker's lease lapses", async () => {
    const { host, execution } = hostExecution({ offset: 1, prefix: "busy" });
    await host.start();
    const runtime = await tenant({ execution: host.tenantExecution, workerId: "worker-a" });
    await openSession(runtime);

    // Another Worker holds a live lease on the session.
    const leaseMs = 1500;
    const other = await openTestSessionStore(runtime);
    let expiresAt: number;
    try {
      const taken = await other.tx((t) =>
        t.takeOwnership("s1", { owner: "worker-other", now: new Date(), leaseMs })
      );
      expect(taken).toMatchObject({ status: "owned" });
      expiresAt = Date.now() + leaseMs;
    } finally {
      await other.close();
    }

    await sendMessage(runtime);
    await until(() => view(runtime), (v) => v.status === "completed", "completed", 20_000);
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt - 50);
    expect(execution.results[0]).toMatchObject({ status: "busy" });
    await until(
      async () => execution.results,
      (r) => r.some((result) => result.status === "done"),
      "the last advance to end"
    );
    expect(execution.results.at(-1)).toEqual({ status: "done" });
    expect(count(await types(runtime), "turn.completed")).toBe(1);
  });

  it("takes over from a Worker stopped mid-advance: the in-flight effect becomes uncertain", async () => {
    // Worker A and Worker B are two processes' worth of state sharing one Tenant database,
    // one Worker URL and one Restate service prefix.
    const streams = new MemoryStreams();
    finally_.push(() => streams.close());
    const model = controlledModel(); // ignores its signal: A's advance never winds down
    const a = hostExecution({ offset: 2, prefix: "takeover", advanceGraceMs: 200 });
    await a.host.start();
    const runtimeA = await tenant({
      execution: a.host.tenantExecution,
      workerId: "worker-a",
      ownerLeaseMs: 1500,
      modelProvider: model.provider,
      streams,
      retainRoot: true,
    });
    finally_.push(() => rm(runtimeA.root, { recursive: true, force: true }));
    cleanups.push(() => model.release());
    await openSession(runtimeA);
    await sendMessage(runtimeA);
    await model.started;
    expect((await stored(runtimeA)).session).toMatchObject({ owner: "worker-a" });

    // Stop Worker A mid-advance. Its advance ignores the abort, is abandoned after the grace
    // period and stops renewing its lease, like a Worker presumed dead but still running.
    await a.host.stop();
    expect(a.execution.results).toEqual([{ status: "busy", retryAfterMs: 0 }]);

    // Worker B comes up with a new Worker id at the same URL and takes the session over. Its
    // Tenant registers before the endpoint serves, so the first retry finds it open.
    const b = hostExecution({ offset: 2, prefix: "takeover" });
    const runtimeB = await tenant({
      hostRoot: runtimeA.root,
      tenantId: runtimeA.tenantId,
      execution: b.host.tenantExecution,
      workerId: "worker-b",
      ownerLeaseMs: 1500,
      modelProvider: model.provider,
      streams,
    });
    await b.host.start();
    await until(() => view(runtimeB), (v) => v.status === "uncertain", "uncertain", 20_000);
    expect(count(await types(runtimeB), "effect.uncertain")).toBe(1);
    await until(
      () => stored(runtimeB),
      (s) => s.session.owner === null,
      "worker-b released the session"
    );
    const after = await stored(runtimeB);
    expect(after.effects.map((effect) => effect.status)).toEqual(["uncertain"]);
    await until(async () => b.execution.results, (r) => r.length > 0, "worker-b's advance to end");
    expect(b.execution.results.at(-1)).toEqual({ status: "done" });

    // A's model call returns at last: its epoch is gone, so it records nothing.
    model.release();
    await sleep(300);
    const events = await types(runtimeB);
    expect(events).not.toContain("turn.completed");
    expect(count(events, "effect.uncertain")).toBe(1);
    expect(model.calls).toBe(1);
    expect((await stored(runtimeB)).session).toMatchObject({ status: "uncertain", owner: null });
  });

  it("re-arms sweeps after Restate state is lost and resumes runnable sessions", async () => {
    // The first Host's Worker stops before a message's wake is delivered.
    const first = hostExecution({
      offset: 3,
      prefix: "lost",
      // The undeliverable wake pauses instead of retrying for the rest of the run.
      restate: { retry: { initialIntervalMs: 50, maxIntervalMs: 200, maxAttempts: 2 } },
    });
    await first.host.start();
    const before = await tenant({ execution: first.host.tenantExecution, retainRoot: true });
    finally_.push(() => rm(before.root, { recursive: true, force: true }));
    await openSession(before);
    await first.host.stop();
    await sendMessage(before);
    expect((await view(before)).status).toBe("runnable");
    await before.close();
    open.splice(open.indexOf(before), 1);

    // Restate's state is gone (a fresh service prefix). The next process knows the Tenant
    // but opens it only when an invocation arrives for it.
    let opened: Started | undefined;
    const next = hostExecution({
      offset: 4,
      prefix: "restored",
      resolve: async (tenantId) => {
        if (!opened)
          opened = await tenant({
            hostRoot: before.root,
            tenantId,
            execution: next.host.tenantExecution,
          });
        return (opened.handle as TenantRuntime).worker;
      },
    });
    await next.host.start();
    await sleep(1000);
    expect(opened).toBeUndefined();

    await next.host.armAll([before.tenantId]);
    await until(
      async () => (opened ? (await view(opened)).status : "closed"),
      (status) => status === "completed",
      "completed",
      20_000
    );
    expect(count(await types(opened!), "turn.completed")).toBe(1);
    // Arming again is harmless.
    await next.host.armAll([before.tenantId]);
  });

  it("delivers a wake whose send failed after commit from the outbox through Restate", async () => {
    const sent: string[] = [];
    let failed = false;
    const { host, execution } = hostExecution({
      offset: 11,
      prefix: "outbox",
      // The message's first send fails, as when Restate is unreachable or the process dies.
      wake: async (inner, tenantId, sessionId, wake) => {
        sent.push(`${wake.reason}:${wake.dedupeKey}`);
        if (wake.reason === "message" && !failed) {
          failed = true;
          throw new Error("Restate ingress unreachable");
        }
        await inner.wake(tenantId, sessionId, wake);
      },
    });
    await host.start();
    const runtime = await tenant({ execution: host.tenantExecution });
    await until(async () => execution.sweeps, (n) => n > 0, "the first sweep pass");
    await openSession(runtime);
    await sendMessage(runtime);
    expect(failed).toBe(true);
    expect((await view(runtime)).status).toBe("runnable");
    await until(() => view(runtime), (v) => v.status === "completed", "completed", 20_000);
    const messages = sent.filter((wake) => wake.startsWith("message:"));
    expect(messages).toHaveLength(2);
    expect(new Set(messages).size).toBe(1);
    expect(count(await types(runtime), "turn.completed")).toBe(1);
    const left = await openTestSessionStore(runtime);
    try {
      expect(await left.tx((t) => t.pendingOutbox(0, 10))).toEqual([]);
    } finally {
      await left.close();
    }
  });

  it("runs one advance for a wake Restate accepted but whose answer was lost, sent again from the outbox", async () => {
    let lost = false;
    const { host, execution } = hostExecution({
      offset: 12,
      prefix: "unacked",
      // Restate accepts the message's wake, but the answer never arrives: the row stays.
      wake: async (inner, tenantId, sessionId, wake) => {
        await inner.wake(tenantId, sessionId, wake);
        if (wake.reason === "message" && !lost) {
          lost = true;
          throw new Error("connection reset before the answer");
        }
      },
    });
    await host.start();
    let calls = 0;
    const runtime = await tenant({
      execution: host.tenantExecution,
      modelProvider: async () => {
        calls += 1;
        return { output: [{ type: "text", text: "done" }] };
      },
    });
    await until(async () => execution.sweeps, (n) => n > 0, "the first sweep pass");
    await openSession(runtime);
    await sendMessage(runtime);
    expect(lost).toBe(true);
    await until(() => view(runtime), (v) => v.status === "completed", "completed", 20_000);
    const store = await openTestSessionStore(runtime);
    try {
      // The sweep sends it again under the same idempotency key, and deletes the row.
      await until(
        () => store.tx((t) => t.pendingOutbox(0, 10)),
        (rows) => rows.length === 0,
        "the outbox to empty",
        20_000
      );
    } finally {
      await store.close();
    }
    // Restate deduplicated the second send: one advance, one model call. A second invocation
    // would have run by now (retries and sweeps every 200 ms).
    await sleep(1500);
    expect(execution.results).toEqual([{ status: "done" }]);
    expect(calls).toBe(1);
    expect(count(await types(runtime), "turn.completed")).toBe(1);
  });

  it("cancels a long model call on the Worker from another node through the control bus", async () => {
    const streams = new MemoryStreams();
    finally_.push(() => streams.close());
    const model = controlledModel({ honorAbort: true });
    cleanups.push(() => model.release());
    const worker = hostExecution({ offset: 5, prefix: "cancel" });
    await worker.host.start();
    const workerNode = await tenant({
      execution: worker.host.tenantExecution,
      workerId: "worker-a",
      modelProvider: model.provider,
      streams,
      retainRoot: true,
    });
    finally_.push(() => rm(workerNode.root, { recursive: true, force: true }));
    // The API node shares the Tenant but never serves the Worker endpoint.
    const api = hostExecution({ offset: 6, prefix: "cancel", services: new Set(["core"] as const) });
    await api.host.start();
    const apiNode = await tenant({
      hostRoot: workerNode.root,
      tenantId: workerNode.tenantId,
      execution: api.host.tenantExecution,
      workerId: "api-node",
      modelProvider: model.provider,
      streams,
    });

    await openSession(apiNode);
    await sendMessage(apiNode);
    await model.started;
    expect((await stored(apiNode)).session).toMatchObject({ owner: "worker-a" });

    const cancelledAt = Date.now();
    await cancel(apiNode);
    await until(async () => model.aborted, (n) => n === 1, "model call aborted", 10_000);
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    await until(
      () => stored(apiNode),
      (s) => s.session.owner === null,
      "worker released the session"
    );
    expect((await view(apiNode)).status).toBe("cancelled");
    const events = await types(apiNode);
    expect(events).toContain("turn.cancelled");
    expect(events).not.toContain("turn.completed");
    expect(model.calls).toBe(1);
    await until(async () => worker.execution.results, (r) => r.length > 0, "the advance to end");
    expect(worker.execution.results).toEqual([{ status: "done" }]);
    expect(api.execution.results).toEqual([]);
  });

  it("reports a paused invocation in Tenant status", async () => {
    const { host } = hostExecution({
      offset: 7,
      prefix: "paused",
      restate: { retry: { initialIntervalMs: 50, maxIntervalMs: 100, maxAttempts: 2 } },
    });
    await host.start();
    const runtime = await tenant({ execution: host.tenantExecution });
    await openSession(runtime);
    // The Session Store is "unreachable" for this Tenant's advances: they throw.
    host.tenantExecution.workers.register(runtime.tenantId, {
      advance: async () => {
        throw new Error("session store unreachable");
      },
      sweep: async () => {},
    });
    await sendMessage(runtime);

    const status = await until(
      async () =>
        TenantStatusSchema.parse(
          await (await fetch(`${runtime.url}/v1/tenant`, { headers: runtime.managementHeaders() })).json()
        ),
      (s) => s.execution?.stuckInvocations.some((i) => i.status === "paused") ?? false,
      "a paused invocation",
      30_000
    );
    expect(status.execution?.error).toBeUndefined();
    expect(status.execution?.stuckInvocations).toEqual([
      expect.objectContaining({
        status: "paused",
        service: "NylorunSession",
        handler: "advance",
        key: `${runtime.tenantId}:s1`,
        lastFailure: expect.stringContaining("session store unreachable"),
      }),
    ]);
  });
});
