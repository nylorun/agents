/**
 * The Restate adapter against a real Restate server (the Docker test stack).
 *
 * The Worker endpoint is served on the host and advertised to Restate, which
 * runs in Docker, as `http://host.docker.internal:<port>`. Every execution in
 * this file uses a service prefix unique to the run, so parallel runs against
 * one Restate server never take each other's invocations.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  createRestateExecution,
  listStuckInvocations,
  type RestateExecution,
  type RestateExecutionOptions,
} from "../../src/adapters/execution/restate.js";
import type { WorkerHandlers } from "../../src/execution/types.js";
import { executionContract } from "../contracts/execution.contract.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worker ports for this file; each execution below gets its own. */
const PORT_BASE = Number(process.env.NYLORUN_TEST_WORKER_PORT_BASE ?? 9180);
/** Where Restate (in Docker) reaches the host. */
const WORKER_HOST_NAME = process.env.NYLORUN_TEST_WORKER_HOST ?? "host.docker.internal";
const RUN = `t${randomUUID().replaceAll("-", "").slice(0, 10)}`;

function options(
  offset: number,
  name: string,
  extra: Partial<RestateExecutionOptions> = {},
): RestateExecutionOptions {
  const endpoints = stackEndpoints();
  const port = PORT_BASE + offset;
  return {
    ingressUrl: endpoints.restate.ingressUrl,
    adminUrl: endpoints.restate.adminUrl,
    // 0.0.0.0: on Linux, host-gateway reaches the host on the bridge address.
    workerListen: { host: "0.0.0.0", port },
    workerAdvertisedUrl: `http://${WORKER_HOST_NAME}:${port}`,
    servicePrefix: `${RUN}_${name}_`,
    registrationTimeoutMs: 30_000,
    logger: () => {},
    ...extra,
  };
}

async function eventually(check: () => void, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(20);
    }
  }
}

const noop: WorkerHandlers = {
  advance: async () => ({ status: "done" }),
  sweep: async () => {},
};

describe.skipIf(!STACK_ENABLED)("Restate execution", () => {
  executionContract("restate", async ({ sweepIntervalMs }) => ({
    execution: createRestateExecution(
      options(0, "contract", {
        sweepIntervalMs,
        retry: { initialIntervalMs: 50, maxIntervalMs: 500 },
      }),
    ),
  }));

  const open: RestateExecution[] = [];
  afterEach(async () => {
    for (const execution of open.splice(0)) await execution.stop();
  });
  async function started(
    offset: number,
    name: string,
    handlers: Partial<WorkerHandlers>,
    extra: Partial<RestateExecutionOptions> = {},
  ): Promise<RestateExecution> {
    const execution = createRestateExecution(options(offset, name, extra));
    open.push(execution);
    await execution.start({ ...noop, ...handlers });
    return execution;
  }
  const ids = () => ({ tenantId: newTenantId(), sessionId: `s-${randomUUID()}` });

  // An advance writes no journal entries while it runs. These two tests run
  // the same 3-second silent advance under short timeouts (standing in for
  // Restate's 1-minute default) and under timeouts raised above it (standing
  // in for the adapter's one-hour default).
  const silentAdvance = (calls: { start: number; end?: number }[]) =>
    async (): Promise<{ status: "done" }> => {
      const call: { start: number; end?: number } = { start: Date.now() };
      calls.push(call);
      await sleep(3000);
      call.end = Date.now();
      return { status: "done" };
    };

  it("fails and retries an advance that outlives short timeouts, without overlapping it", async () => {
    const calls: { start: number; end?: number }[] = [];
    const execution = await started(1, "short", { advance: silentAdvance(calls) }, {
      timeouts: { inactivityMs: 300, abortMs: 300 },
      retry: { initialIntervalMs: 50 },
    });
    const { tenantId, sessionId } = ids();
    await execution.wake(tenantId, sessionId, { reason: "message" });
    await eventually(() => expect(calls.length).toBeGreaterThanOrEqual(2), 20_000);
    // Restate 1.7 records the attempt as failed at the abort timeout but does
    // not reset the stream, so the retry starts only after the first attempt
    // returns: one key never runs two advances at once.
    expect(calls[1]!.start).toBeGreaterThanOrEqual(calls[0]!.end!);
  });

  it("runs an advance past the inactivity timeout exactly once when the timeouts are raised", async () => {
    const calls: { start: number; end?: number }[] = [];
    let aborted = false;
    const execution = await started(
      2,
      "long",
      {
        advance: async (tenantId, sessionId, signal) => {
          signal.addEventListener("abort", () => (aborted = true));
          return silentAdvance(calls)();
        },
      },
      { timeouts: { inactivityMs: 5000, abortMs: 5000 } },
    );
    const { tenantId, sessionId } = ids();
    await execution.wake(tenantId, sessionId, { reason: "message" });
    await eventually(() => expect(calls[0]?.end).toBeDefined());
    await sleep(1500);
    expect(calls).toHaveLength(1);
    expect(aborted).toBe(false);
  });

  it("keeps one sweep chain per Tenant however often it is armed, and re-arms after disarm", async () => {
    const starts: number[] = [];
    const interval = 200;
    const execution = await started(
      3,
      "sweep",
      {
        sweep: async () => {
          starts.push(Date.now());
        },
      },
      { sweepIntervalMs: interval },
    );
    const { tenantId } = ids();
    await Promise.all([1, 2, 3, 4].map(() => execution.armSweep(tenantId)));
    await eventually(() => expect(starts.length).toBeGreaterThanOrEqual(3));
    await execution.armSweep(tenantId);
    await sleep(interval * 4);
    await execution.armSweep(tenantId);
    await sleep(interval * 3);
    const gaps = starts.slice(1).map((at, i) => at - starts[i]!);
    // Two chains would interleave, leaving gaps well under the interval.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(interval * 0.75);

    await execution.disarmSweep(tenantId);
    await sleep(interval * 3);
    const afterDisarm = starts.length;
    await sleep(interval * 3);
    expect(starts.length).toBe(afterDisarm);

    await execution.armSweep(tenantId);
    await eventually(() => expect(starts.length).toBeGreaterThanOrEqual(afterDisarm + 2));
    await execution.disarmSweep(tenantId);
  });

  it("replaces a timer that is set again", async () => {
    const fired: number[] = [];
    const execution = await started(4, "timer", {
      fire: async () => {
        fired.push(Date.now());
      },
    });
    const { tenantId } = ids();
    const key = `t-${randomUUID()}`;
    await execution.timer(tenantId, key, new Date(Date.now() + 300));
    const later = Date.now() + 1200;
    await execution.timer(tenantId, key, new Date(later));
    await eventually(() => expect(fired).toHaveLength(1));
    expect(fired[0]!).toBeGreaterThanOrEqual(later - 50);
    await sleep(500);
    expect(fired).toHaveLength(1);
  });

  it("pauses an advance that keeps failing and lists it as stuck", async () => {
    let calls = 0;
    const execution = await started(
      5,
      "stuck",
      {
        advance: async () => {
          calls += 1;
          throw new Error("session store unreachable");
        },
      },
      { retry: { initialIntervalMs: 20, maxIntervalMs: 50, maxAttempts: 3 } },
    );
    const { tenantId, sessionId } = ids();
    await execution.wake(tenantId, sessionId, { reason: "message" });
    const listed = () =>
      listStuckInvocations({
        adminUrl: stackEndpoints().restate.adminUrl,
        servicePrefix: `${RUN}_stuck_`,
        tenantId,
      });
    let stuck: Awaited<ReturnType<typeof listed>> = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      stuck = await listed();
      if (stuck.some((row) => row.status === "paused")) break;
      await sleep(200);
    }
    expect(calls).toBe(3);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      status: "paused",
      service: "NylorunSession",
      handler: "advance",
      key: `${tenantId}:${sessionId}`,
      tenantId,
    });
    expect(stuck[0]!.lastFailure).toContain("session store unreachable");
    expect(await listStuckInvocations({
      adminUrl: stackEndpoints().restate.adminUrl,
      servicePrefix: `${RUN}_stuck_`,
      tenantId: newTenantId(),
    })).toEqual([]);
  });

  it("refuses registration when Restate does not sign with the configured identity key", async () => {
    const execution = createRestateExecution(
      options(6, "identity", {
        // A valid key that the test stack's Restate does not hold.
        identityKeys: ["publickeyv1_CgojDdtCBsK8zYsbqruLmwXgWqMYxDfu3n5qJdcJeNtv"],
        registrationTimeoutMs: 2000,
      }),
    );
    await expect(execution.start(noop)).rejects.toThrow(/registration failed/);
  });
});
