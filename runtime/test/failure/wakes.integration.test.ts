/**
 * Failure cases of architecture §17 about wakes and Restate's state, on Postgres + Restate + S2
 * (`README.md`):
 *
 * - §17.1 duplicate wake;
 * - §17.2 a wake lost between commit and send;
 * - §17.11 Restate state wiped.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../../src/core/provider.js";
import type { DurableExecution, Wake } from "../../src/execution/types.js";
import {
  controlledModel,
  openSession,
  sendMessage,
  until,
  view,
} from "../host/execution-support.js";
import {
  FULL_STACK,
  FailureTenant,
  completeHistory,
  countOf,
  quiet,
  sessionRow,
  sleep,
  wipeRestate,
  workerOf,
  type Node,
} from "./support.js";

const tenants: FailureTenant[] = [];
afterEach(async () => {
  for (const tenant of tenants.splice(0).reverse()) await tenant.dispose();
});
function failureTenant(): FailureTenant {
  const tenant = new FailureTenant();
  tenants.push(tenant);
  return tenant;
}

/** Answers at once, counting calls. */
function countingModel() {
  const model = {
    calls: 0,
    provider: (async () => {
      model.calls += 1;
      return { output: [{ type: "text", text: "done" }] };
    }) as ModelProvider,
  };
  return model;
}

describe.skipIf(!FULL_STACK)("§17 wake failures on Postgres, Restate and S2", () => {
  it("§17.1 duplicate wakes, deduped or not, during and after a turn run it once", async () => {
    const t = failureTenant();
    const model = controlledModel();
    t.onDispose(() => model.release());
    const worker = t.worker({ offset: 5, prefix: "dup" });
    await worker.host.start();
    const node = await t.node({ worker, modelProvider: model.provider });
    await openSession(node);
    await sendMessage(node);
    await model.started;

    // A client retry of the same command returns the stored response and starts nothing.
    await sendMessage(node);
    const wakes: Wake[] = [
      { reason: "message", dedupeKey: "same" },
      { reason: "message", dedupeKey: "same" },
      { reason: "recover" },
      { reason: "recover" },
      { reason: "action_result" },
      { reason: "message" },
    ];
    const wakeAll = () =>
      Promise.all(wakes.map((wake) => worker.execution.wake(t.tenantId, "s1", wake)));
    await wakeAll();
    model.release();
    await until(() => view(node), (v) => v.status === "completed", "completed", 20_000);
    await wakeAll();
    await quiet(worker);

    expect(worker.execution.results.length).toBeGreaterThan(1);
    expect(worker.execution.results.every((result) => result.status === "done")).toBe(true);
    const history = await completeHistory(node);
    expect(countOf(history, "command.message")).toBe(1);
    expect(countOf(history, "turn.completed")).toBe(1);
    expect(model.calls).toBe(1);
    expect(await sessionRow(node)).toMatchObject({ status: "completed", owner: null });
  });

  it("§17.2 a wake lost between commit and send: the Tenant sweep on Restate recovers it", async () => {
    const t = failureTenant();
    const model = countingModel();
    const lost: Wake[] = [];
    const worker = t.worker({
      offset: 6,
      prefix: "lost",
      // The message's wake never reaches Restate, as if the process died right after commit.
      wrap: (inner): DurableExecution => ({
        wake: async (tenantId, sessionId, wake) => {
          if (wake.reason === "message") lost.push(wake);
          else await inner.wake(tenantId, sessionId, wake);
        },
        timer: (...args) => inner.timer(...args),
        armSweep: (tenantId) => inner.armSweep(tenantId),
        disarmSweep: (tenantId) => inner.disarmSweep(tenantId),
        start: (handlers) => inner.start(handlers),
        stop: () => inner.stop(),
        stuckInvocations: (tenantId) => inner.stuckInvocations!(tenantId),
      }),
    });
    await worker.host.start();
    const node = await t.node({ worker, modelProvider: model.provider });
    await openSession(node);
    await sendMessage(node);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.dedupeKey).toMatch(/^message:/);

    await until(() => view(node), (v) => v.status === "completed", "completed", 20_000);
    const history = await completeHistory(node);
    expect(countOf(history, "command.message")).toBe(1);
    expect(countOf(history, "turn.completed")).toBe(1);
    expect(model.calls).toBe(1);
  });

  it("§17.11 Restate state wiped: Workers re-arm the sweeps at startup and runnable sessions resume", async () => {
    const t = failureTenant();
    const model = countingModel();
    // The first process: its Worker stops before the message's wake is delivered.
    const first = t.worker({ offset: 7, prefix: "wiped" });
    await first.host.start();
    const before = await t.node({ worker: first, workerId: "worker-a", modelProvider: model.provider });
    await openSession(before);
    await first.host.stop();
    await sendMessage(before);
    expect((await view(before)).status).toBe("runnable");
    await t.closeNode(before);

    // Restate loses everything: the queued wake, the Tenant's sweep chain, the deployment.
    await wipeRestate();

    // The next process at the same Worker URL knows the Tenant but opens it only when an
    // invocation arrives for it.
    let opened: Promise<Node> | undefined;
    const next = t.worker({
      offset: 7,
      prefix: "wiped",
      resolve: async () => {
        opened ??= t.node({ worker: next, workerId: "worker-b", modelProvider: model.provider });
        return workerOf(await opened);
      },
    });
    await next.host.start();
    await sleep(1500);
    expect(opened).toBeUndefined();
    expect(await sessionRow(before)).toMatchObject({ status: "runnable", owner: null });

    // What every Worker does at startup (`host/main.ts`): arm the sweep of every Tenant.
    await next.host.armAll([t.tenantId]);
    await until(
      async () => (opened ? (await view(await opened)).status : "closed"),
      (status) => status === "completed",
      "the runnable session to resume",
      30_000
    );
    const node = await opened!;
    // Arming again is harmless.
    await next.host.armAll([t.tenantId]);
    await quiet(next);
    const history = await completeHistory(node);
    expect(countOf(history, "command.message")).toBe(1);
    expect(countOf(history, "turn.completed")).toBe(1);
    expect(model.calls).toBe(1);
  });
});
