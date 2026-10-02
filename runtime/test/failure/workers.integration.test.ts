/**
 * Failure cases of architecture §17 about Workers, on Postgres + Restate + S2 (`README.md`):
 *
 * - §17.3 a Worker killed during a model effect;
 * - §17.4 two advances racing for one session;
 * - §17.9 cancel delivered to another Worker;
 * - §17.10 a Restate abort during a long advance.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../../src/core/provider.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { CONTROL_STREAM } from "../../src/streams/types.js";
import { testPool } from "../support/store.js";
import {
  cancel,
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
  effectsOf,
  sessionRow,
  sleep,
  typesOf,
  workerOf,
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

/** Answers after `ms` whatever its signal says, counting calls. */
function slowModel(ms: number) {
  const model = {
    calls: 0,
    provider: (async () => {
      model.calls += 1;
      await sleep(ms);
      return { output: [{ type: "text", text: "slow" }] };
    }) as ModelProvider,
  };
  return model;
}

describe.skipIf(!FULL_STACK)("§17 Worker failures on Postgres, Restate and S2", () => {
  it("§17.3 a Worker killed during a model effect: the effect is uncertain after takeover, never called again, and the session is usable", async () => {
    const t = failureTenant();
    const model = controlledModel(); // ignores its signal, like a call cut off by a crash
    t.onDispose(() => model.release());

    // Worker A takes the turn and calls the model.
    const a = t.worker({ offset: 0, prefix: "killed", advanceGraceMs: 200 });
    await a.host.start();
    const nodeA = await t.node({
      worker: a,
      workerId: "worker-a",
      ownerLeaseMs: 1500,
      modelProvider: model.provider,
    });
    await openSession(nodeA);
    await sendMessage(nodeA);
    await model.started;
    expect(await sessionRow(nodeA)).toMatchObject({ status: "running", owner: "worker-a" });
    expect((await effectsOf(nodeA)).map((effect) => effect.status)).toEqual(["invoking"]);

    // Worker A goes away mid-call: its endpoint stops, its advance is abandoned and stops
    // renewing the lease, and the process closes the Tenant.
    await a.host.stop();
    await t.closeNode(nodeA);

    // Worker B comes up at the same URL; Restate retries the advance there.
    const b = t.worker({ offset: 0, prefix: "killed" });
    const nodeB = await t.node({
      worker: b,
      workerId: "worker-b",
      ownerLeaseMs: 1500,
      modelProvider: model.provider,
    });
    await b.host.start();
    await until(() => view(nodeB), (v) => v.status === "uncertain", "uncertain", 30_000);
    await until(() => sessionRow(nodeB), (s) => s.owner === null, "worker-b released the session");
    expect((await effectsOf(nodeB)).map((effect) => effect.status)).toEqual(["uncertain"]);
    const history = await completeHistory(nodeB);
    expect(countOf(history, "effect.uncertain")).toBe(1);
    expect(typesOf(history)).not.toContain("turn.completed");
    expect(model.calls).toBe(1);
    await until(async () => b.execution.results, (r) => r.length > 0, "worker-b's advance to end");
    expect(b.execution.results.at(-1)).toEqual({ status: "done" });

    // The cut-off call returns at last: Worker A's advance is gone and nothing is recorded.
    model.release();
    await sleep(300);
    expect(await completeHistory(nodeB)).toEqual(history);
    expect(model.calls).toBe(1);

    // Usable afterwards: the uncertain turn is cancelled and the next turn completes.
    await cancel(nodeB);
    await sendMessage(nodeB, "s1", 2);
    await until(() => view(nodeB), (v) => v.status === "completed", "the next turn", 20_000);
    const after = await completeHistory(nodeB);
    expect(after.slice(0, history.length)).toEqual(history);
    expect(countOf(after, "turn.cancelled")).toBe(1);
    expect(countOf(after, "turn.completed")).toBe(1);
    expect(model.calls).toBe(2);
  });

  it("§17.4 two advances racing for one session: busy while the owner lives, ownership.lost once it is taken over, and no duplicate event", async () => {
    const t = failureTenant();
    const model = controlledModel();
    t.onDispose(() => model.release());
    const a = t.worker({ offset: 1, prefix: "race" });
    await a.host.start();
    const nodeA = await t.node({
      worker: a,
      workerId: "worker-a",
      ownerLeaseMs: 60_000,
      modelProvider: model.provider,
    });
    // Another process with the Tenant open; its advances are called directly, as a duplicate
    // delivery would call them.
    const nodeB = await t.node({
      worker: t.worker({ offset: 1, prefix: "race", services: new Set(["core"] as const) }),
      workerId: "worker-b",
      ownerLeaseMs: 60_000,
      modelProvider: model.provider,
    });
    await openSession(nodeA);
    await sendMessage(nodeA);
    await model.started;
    const before = await completeHistory(nodeA);
    const { epoch } = await sessionRow(nodeA);

    // While worker-a's lease is live, every racing advance on either node is busy.
    const signal = new AbortController().signal;
    const raced = await Promise.all([
      ...Array.from({ length: 5 }, () => workerOf(nodeB).advance("s1", signal)),
      ...Array.from({ length: 3 }, () => workerOf(nodeA).advance("s1", signal)),
    ]);
    expect(raced.map((result) => result.status)).toEqual(Array(8).fill("busy"));
    expect(await completeHistory(nodeB)).toEqual(before);
    expect(await sessionRow(nodeB)).toMatchObject({ owner: "worker-a", epoch });

    // worker-a stalls past its lease (presumed dead, still running): worker-b takes over.
    await testPool().unsafe(
      `UPDATE "${tenantSchemaName(t.tenantId)}".sessions
         SET owner_expires_at = now() - interval '1 second' WHERE id = 's1'`
    );
    expect(await workerOf(nodeB).advance("s1", signal)).toEqual({ status: "done" });
    expect(await sessionRow(nodeB)).toMatchObject({
      status: "uncertain",
      owner: null,
      epoch: epoch + 1,
    });
    const taken = await completeHistory(nodeB);
    expect(taken.slice(0, before.length)).toEqual(before);
    expect(typesOf(taken.slice(before.length))).toEqual(["effect.uncertain"]);

    // worker-a's model call returns: its next write fails the epoch check (ownership.lost), and
    // its advance ends without writing anything.
    model.release();
    await until(async () => a.execution.results, (r) => r.length > 0, "worker-a's advance to end");
    expect(a.execution.results).toEqual([{ status: "done" }]);
    expect(await completeHistory(nodeA)).toEqual(taken);
    expect((await effectsOf(nodeA)).map((effect) => effect.status)).toEqual(["uncertain"]);
    // (A sweep wake queued behind worker-a's advance may take and release the session again.)
    const settled = await sessionRow(nodeA);
    expect(settled).toMatchObject({ status: "uncertain", owner: null });
    expect(settled.epoch).toBeGreaterThanOrEqual(epoch + 1);
    expect(model.calls).toBe(1);
  });

  it("§17.9 cancel delivered to another Worker: the API node's cancel aborts the model call on the Worker through the control stream", async () => {
    const t = failureTenant();
    const model = controlledModel({ honorAbort: true });
    t.onDispose(() => model.release());
    const worker = t.worker({ offset: 2, prefix: "cancel" });
    await worker.host.start();
    const workerNode = await t.node({
      worker,
      workerId: "worker-a",
      modelProvider: model.provider,
    });
    // The API node shares the Tenant but never serves the Worker endpoint.
    const api = t.worker({ offset: 2, prefix: "cancel", services: new Set(["core"] as const) });
    const apiNode = await t.node({ worker: api, workerId: "api-node", modelProvider: model.provider });

    await openSession(apiNode);
    await sendMessage(apiNode);
    await model.started;
    expect(await sessionRow(apiNode)).toMatchObject({ owner: "worker-a" });

    await cancel(apiNode);
    await until(async () => model.aborted, (n) => n === 1, "the model call aborted", 15_000);
    await until(() => sessionRow(apiNode), (s) => s.owner === null, "the Worker released the session");
    expect((await view(apiNode)).status).toBe("cancelled");
    const history = await completeHistory(apiNode);
    expect(countOf(history, "turn.cancelled")).toBe(1);
    expect(typesOf(history)).not.toContain("turn.completed");
    expect(model.calls).toBe(1);
    await until(async () => worker.execution.results, (r) => r.length > 0, "the advance to end");
    expect(worker.execution.results).toEqual([{ status: "done" }]);
    expect(api.execution.results).toEqual([]);

    const control: unknown[] = [];
    for await (const record of apiNode.streams.read(t.tenantId, CONTROL_STREAM, 0, {
      follow: false,
    }))
      control.push(record.body);
    expect(control).toContainEqual({ type: "session.cancel", sessionId: "s1" });
    expect(await completeHistory(workerNode)).toEqual(history);
  });

  describe("§17.10 a Restate abort during a long advance", () => {
    // Restate aborts an attempt that makes no journal progress for inactivity + abort timeout.
    // These timeouts (0.6 s together) stand in for the adapter's one-hour defaults.
    const shortTimeouts = { timeouts: { inactivityMs: 300, abortMs: 300 } };

    it("retries an advance Restate aborted without calling the model again: the turn completes once", async () => {
      const t = failureTenant();
      const model = slowModel(2500);
      const worker = t.worker({ offset: 3, prefix: "abort", restate: shortTimeouts });
      await worker.host.start();
      const node = await t.node({ worker, modelProvider: model.provider });
      await openSession(node);
      await sendMessage(node);
      await until(() => view(node), (v) => v.status === "completed", "completed", 30_000);
      // Restate gave up on the first attempt while the model answered and ran the advance again;
      // the retry found the turn settled.
      await until(
        async () => worker.execution.results,
        (results) => results.length >= 2,
        "Restate's retry of the aborted attempt",
        30_000
      );
      expect(worker.execution.results.every((result) => result.status === "done")).toBe(true);
      const history = await completeHistory(node);
      expect(countOf(history, "command.message")).toBe(1);
      expect(countOf(history, "turn.completed")).toBe(1);
      expect(model.calls).toBe(1);
    });

    it("bounds a runaway advance with its deadline and grace; the retry takes over and the stale advance writes nothing", async () => {
      const t = failureTenant();
      const model = controlledModel(); // ignores its signal: the advance cannot wind down
      t.onDispose(() => model.release());
      const worker = t.worker({
        offset: 4,
        prefix: "runaway",
        restate: shortTimeouts,
        advanceDeadlineMs: 1000,
        advanceGraceMs: 200,
      });
      await worker.host.start();
      const node = await t.node({ worker, ownerLeaseMs: 1500, modelProvider: model.provider });
      await openSession(node);
      await sendMessage(node);
      await model.started;

      // The deadline aborts the advance, the grace period abandons it (`busy`), its lease lapses
      // and a later advance takes the session over.
      await until(() => view(node), (v) => v.status === "uncertain", "uncertain", 30_000);
      await until(() => sessionRow(node), (s) => s.owner === null, "the session released");
      expect(worker.execution.results).toContainEqual({ status: "busy", retryAfterMs: 0 });
      const history = await completeHistory(node);
      expect(countOf(history, "effect.uncertain")).toBe(1);
      expect(typesOf(history)).not.toContain("turn.completed");

      // The runaway call returns: its epoch is gone, so it records nothing.
      model.release();
      await sleep(500);
      expect(await completeHistory(node)).toEqual(history);
      expect((await effectsOf(node)).map((effect) => effect.status)).toEqual(["uncertain"]);
      expect(model.calls).toBe(1);
    });
  });
});
