/**
 * A graceful Worker stop on a real Restate server (the Docker test stack; architecture §10.5,
 * §11.4, `tenant/worker.ts` "Abort reasons"): the stop lands while the model answers, the
 * answer is recorded, nothing is settled, and the next Worker at the same URL resumes the turn
 * from its checkpoint and completes it without calling the model again. The in-process
 * version is in `test/tenant/shutdown.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRestateExecution,
  type RestateExecutionOptions,
} from "../../src/adapters/execution/restate.js";
import type { ModelProvider } from "../../src/core/provider.js";
import type {
  AdvanceResult,
  DurableExecution,
  WorkerHandlers,
} from "../../src/execution/types.js";
import { createHostExecution, type HostExecution } from "../../src/host/execution.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import {
  boot,
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

/** Worker ports for this file (9220–9229 by default). */
const PORT_BASE = Number(process.env.NYLORUN_TEST_SHUTDOWN_WORKER_PORT_BASE ?? 9220);
/** Where Restate (in Docker) reaches the host. */
const WORKER_HOST_NAME = process.env.NYLORUN_TEST_WORKER_HOST ?? "host.docker.internal";
const RUN = `s${randomUUID().replaceAll("-", "").slice(0, 10)}`;

function restateOptions(offset: number, prefix: string): RestateExecutionOptions {
  const endpoints = stackEndpoints();
  const port = PORT_BASE + offset;
  return {
    ingressUrl: endpoints.restate.ingressUrl,
    adminUrl: endpoints.restate.adminUrl,
    workerListen: { host: "0.0.0.0", port },
    workerAdvertisedUrl: `http://${WORKER_HOST_NAME}:${port}`,
    servicePrefix: `${RUN}_${prefix}_`,
    sweepIntervalMs: 200,
    retry: { initialIntervalMs: 50, maxIntervalMs: 500 },
    registrationTimeoutMs: 30_000,
    logger: () => {},
  };
}

/** Delegates to `inner`, recording every advance result the Worker returns. */
function recording(inner: DurableExecution): DurableExecution & { results: AdvanceResult[] } {
  const results: AdvanceResult[] = [];
  return {
    results,
    wake: (...args) => inner.wake(...args),
    timer: (...args) => inner.timer(...args),
    armSweep: (tenantId) => inner.armSweep(tenantId),
    disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
    stop: () => inner.stop(),
    start: (handlers: WorkerHandlers) =>
      inner.start({
        ...handlers,
        advance: async (...args) => {
          const result = await handlers.advance(...args);
          results.push(result);
          return result;
        },
      }),
  };
}

const open: Started[] = [];
const hosts: HostExecution[] = [];
const finally_: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => undefined);
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
  for (const cleanup of finally_.splice(0).reverse()) await cleanup();
});

function hostExecution(offset: number, prefix: string) {
  const execution = recording(createRestateExecution(restateOptions(offset, prefix)));
  const host = createHostExecution({ execution, role: "all", resolve: async () => undefined });
  hosts.push(host);
  return { host, execution };
}

async function tenant(options: Parameters<typeof boot>[0]): Promise<Started> {
  const runtime = await boot({ sweepIntervalMs: 200, ...options });
  open.push(runtime);
  return runtime;
}

describe.skipIf(!STACK_ENABLED)("graceful Worker stop on Restate", () => {
  it("leaves the turn to the next Worker, which completes it from the recorded outcome", async () => {
    const streams = new MemoryStreams();
    finally_.push(() => streams.close());
    const a = hostExecution(0, "stop");
    await a.host.start();
    let calls = 0;
    let stopping: Promise<void> | undefined;
    const model: ModelProvider = async () => {
      calls += 1;
      // Worker A stops while the model answers.
      stopping ??= a.host.stop();
      return { output: [{ type: "text", text: "answer from worker A" }] };
    };
    const runtimeA = await tenant({
      execution: a.host.tenantExecution,
      workerId: "worker-a",
      modelProvider: model,
      streams,
      retainRoot: true,
    });
    finally_.push(() => rm(runtimeA.root, { recursive: true, force: true }));
    await openSession(runtimeA);
    await sendMessage(runtimeA);
    await until(async () => stopping, (s) => s !== undefined, "worker A stopping", 20_000);
    await stopping;

    // Nothing settled: the answer is recorded, the session is running and unowned.
    expect(a.execution.results).toEqual([{ status: "busy", retryAfterMs: 0 }]);
    const left = await stored(runtimeA);
    expect(left.session).toMatchObject({ status: "running", owner: null });
    expect(left.effects.map((effect) => effect.status)).toEqual(["completed"]);
    const before = await types(runtimeA);
    for (const settled of ["turn.cancelled", "turn.failed", "turn.completed", "effect.uncertain"])
      expect(before).not.toContain(settled);

    // Worker B: a new Worker id at the same URL and service prefix.
    const b = hostExecution(0, "stop");
    const runtimeB = await tenant({
      hostRoot: runtimeA.root,
      tenantId: runtimeA.tenantId,
      execution: b.host.tenantExecution,
      workerId: "worker-b",
      modelProvider: model,
      streams,
    });
    await b.host.start();
    await until(() => view(runtimeB), (v) => v.status === "completed", "completed", 20_000);
    expect(calls).toBe(1);
    const items = (await (
      await fetch(`${runtimeB.url}/v1/sessions/s1/items`, { headers: server })
    ).json()) as { items: { type: string; payload?: unknown }[] };
    expect(count(items.items.map((item) => item.type), "turn.completed")).toBe(1);
    expect(
      JSON.stringify(items.items.find((item) => item.type === "turn.completed")?.payload)
    ).toContain("answer from worker A");
    expect(b.execution.results.at(-1)).toEqual({ status: "done" });
    expect((await stored(runtimeB)).session.owner).toBeNull();
  });
});
