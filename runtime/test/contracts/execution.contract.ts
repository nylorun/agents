/**
 * Durable Session Execution contract (architecture §12.3). Every
 * `DurableExecution` runs this suite: the in-process implementation and the
 * Restate adapter.
 *
 * The factory must configure a sweep interval of at most `SWEEP_INTERVAL_MS`
 * and retry a throwing handler within a second. Session ids are random per
 * test, so a shared Restate server can run the suite repeatedly.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type {
  AdvanceResult,
  DurableExecution,
  WorkerHandlers,
} from "../../src/execution/types.js";

export const SWEEP_INTERVAL_MS = 100;

export interface ExecutionHarness {
  execution: DurableExecution;
  /** Called after `execution.stop()`. */
  dispose?(): Promise<void>;
}

export type ExecutionFactory = (options: {
  sweepIntervalMs: number;
}) => Promise<ExecutionHarness>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(
  check: () => void,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(10);
    }
  }
}

/** Waits until `count()` has not changed for `quietMs`. */
async function settled(count: () => number, quietMs = 300): Promise<void> {
  let last = count();
  let since = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error("never settled");
    await sleep(10);
    if (count() !== last) {
      last = count();
      since = Date.now();
    }
  }
}

interface Call {
  tenantId: string;
  sessionId: string;
  startedAt: number;
  signal: AbortSignal;
}

export function executionContract(
  name: string,
  factory: ExecutionFactory,
): void {
  describe(`DurableExecution contract: ${name}`, () => {
    const open: ExecutionHarness[] = [];

    afterEach(async () => {
      for (const harness of open.splice(0)) {
        await harness.execution.stop();
        await harness.dispose?.();
      }
    });

    async function started(handlers: Partial<WorkerHandlers>) {
      const harness = await factory({ sweepIntervalMs: SWEEP_INTERVAL_MS });
      open.push(harness);
      await harness.execution.start({
        advance: async () => ({ status: "done" }),
        sweep: async () => {},
        ...handlers,
      });
      return harness.execution;
    }

    const ids = () => ({ tenantId: newTenantId(), sessionId: `s-${randomUUID()}` });

    it("runs advance for a woken session with an abort signal", async () => {
      const calls: Call[] = [];
      const execution = await started({
        advance: async (tenantId, sessionId, signal) => {
          calls.push({ tenantId, sessionId, signal, startedAt: Date.now() });
          return { status: "done" };
        },
      });
      const { tenantId, sessionId } = ids();
      await execution.wake(tenantId, sessionId, { reason: "message" });
      await eventually(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ tenantId, sessionId });
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
      await settled(() => calls.length);
      expect(calls).toHaveLength(1);
    });

    it("never runs two advances for one key at once, and runs one after the last wake", async () => {
      let active = 0;
      let maxActive = 0;
      const calls: Call[] = [];
      const execution = await started({
        advance: async (tenantId, sessionId, signal) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          calls.push({ tenantId, sessionId, signal, startedAt: Date.now() });
          await sleep(40);
          active -= 1;
          return { status: "done" };
        },
      });
      const { tenantId, sessionId } = ids();
      let lastWake = 0;
      for (let i = 0; i < 10; i++) {
        lastWake = Date.now();
        await execution.wake(tenantId, sessionId, { reason: "message" });
        await sleep(i % 3 === 0 ? 25 : 1);
      }
      await settled(() => calls.length, 400);
      expect(maxActive).toBe(1);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.at(-1)!.startedAt).toBeGreaterThanOrEqual(lastWake);
    });

    it("runs advances for different sessions concurrently", async () => {
      let active = 0;
      let maxActive = 0;
      const execution = await started({
        advance: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(300);
          active -= 1;
          return { status: "done" };
        },
      });
      const a = ids();
      const b = { tenantId: a.tenantId, sessionId: `s-${randomUUID()}` };
      await execution.wake(a.tenantId, a.sessionId, { reason: "message" });
      await execution.wake(b.tenantId, b.sessionId, { reason: "message" });
      await eventually(() => expect(maxActive).toBe(2));
    });

    it("dedupes wakes with the same dedupe key", async () => {
      const calls: string[] = [];
      const execution = await started({
        advance: async (_tenantId, sessionId) => {
          calls.push(sessionId);
          return { status: "done" };
        },
      });
      const { tenantId, sessionId } = ids();
      for (let i = 0; i < 3; i++) {
        await execution.wake(tenantId, sessionId, { reason: "action_result", dedupeKey: "result-1" });
        await settled(() => calls.length, 150);
      }
      expect(calls).toHaveLength(1);
      await execution.wake(tenantId, sessionId, { reason: "action_result", dedupeKey: "result-2" });
      await eventually(() => expect(calls).toHaveLength(2));
      await settled(() => calls.length, 150);
      await execution.wake(tenantId, sessionId, { reason: "recover" });
      await eventually(() => expect(calls).toHaveLength(3));
      await settled(() => calls.length, 150);
      await execution.wake(tenantId, sessionId, { reason: "recover" });
      await eventually(() => expect(calls).toHaveLength(4));
      // The same dedupe key on another session is a different cause.
      const other = `s-${randomUUID()}`;
      await execution.wake(tenantId, other, { reason: "action_result", dedupeKey: "result-1" });
      await eventually(() => expect(calls).toContain(other));
    });

    it("re-wakes the same key after a busy result", async () => {
      const calls: Call[] = [];
      const execution = await started({
        advance: async (tenantId, sessionId, signal): Promise<AdvanceResult> => {
          calls.push({ tenantId, sessionId, signal, startedAt: Date.now() });
          return calls.length === 1
            ? { status: "busy", retryAfterMs: 200 }
            : { status: "done" };
        },
      });
      const { tenantId, sessionId } = ids();
      await execution.wake(tenantId, sessionId, { reason: "message" });
      await eventually(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toMatchObject({ tenantId, sessionId });
      expect(calls[1]!.startedAt - calls[0]!.startedAt).toBeGreaterThanOrEqual(150);
      await settled(() => calls.length);
      expect(calls).toHaveLength(2);
    });

    it("retries an advance that throws", async () => {
      let calls = 0;
      const execution = await started({
        advance: async () => {
          calls += 1;
          if (calls === 1) throw new Error("store unreachable");
          return { status: "done" };
        },
      });
      const { tenantId, sessionId } = ids();
      await execution.wake(tenantId, sessionId, { reason: "message" });
      await eventually(() => expect(calls).toBe(2));
      await settled(() => calls);
      expect(calls).toBe(2);
    });

    it("fires a timer at or after its time", async () => {
      const fired: { tenantId: string; key: string; at: number }[] = [];
      const execution = await started({
        fire: async (tenantId, key) => {
          fired.push({ tenantId, key, at: Date.now() });
        },
      });
      const { tenantId } = ids();
      const key = `timer-${randomUUID()}`;
      const at = Date.now() + 200;
      await execution.timer(tenantId, key, new Date(at));
      await eventually(() => expect(fired).toHaveLength(1));
      expect(fired[0]).toMatchObject({ tenantId, key });
      expect(fired[0]!.at).toBeGreaterThanOrEqual(at - 20);
    });

    it("arms a self-re-arming sweep once per Tenant, and disarms it", async () => {
      const sweeps: string[] = [];
      let active = 0;
      let maxActive = 0;
      const execution = await started({
        sweep: async (tenantId) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          sweeps.push(tenantId);
          await sleep(10);
          active -= 1;
        },
      });
      const { tenantId } = ids();
      await execution.armSweep(tenantId);
      await execution.armSweep(tenantId);
      await eventually(() => expect(sweeps.length).toBeGreaterThanOrEqual(3));
      expect(new Set(sweeps)).toEqual(new Set([tenantId]));
      expect(maxActive).toBe(1);
      await execution.disarmSweep(tenantId);
      await settled(() => sweeps.length, SWEEP_INTERVAL_MS * 4);
      const after = sweeps.length;
      await sleep(SWEEP_INTERVAL_MS * 3);
      expect(sweeps.length).toBe(after);
    });

    it("aborts running advances on stop and waits for them", async () => {
      let finished = false;
      let entered = false;
      const harness = await factory({ sweepIntervalMs: SWEEP_INTERVAL_MS });
      await harness.execution.start({
        advance: async (_tenantId, _sessionId, signal) => {
          entered = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await sleep(20);
          finished = true;
          return { status: "done" };
        },
        sweep: async () => {},
      });
      const { tenantId, sessionId } = ids();
      await harness.execution.wake(tenantId, sessionId, { reason: "message" });
      await eventually(() => expect(entered).toBe(true));
      await harness.execution.stop();
      expect(finished).toBe(true);
      await harness.dispose?.();
    });
  });
}
