import { describe, expect, it } from "vitest";
import type { DurableExecution, WorkerHandlers } from "../../src/execution/types.js";
import { servesWorker, startWorker, stopWorker } from "../../src/infra/workers.js";

function recordingExecution(): DurableExecution & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    wake: async () => {},
    timer: async () => {},
    armSweep: async () => {},
    disarmSweep: async () => {},
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
  };
}

const handlers: WorkerHandlers = {
  advance: async () => ({ status: "done" }),
  sweep: async () => {},
};

describe("startWorker", () => {
  it("never starts the execution for the api role", async () => {
    const execution = recordingExecution();
    const handle = await startWorker({ role: "api", execution, handlers });
    expect(handle).toEqual({ role: "api", serving: false });
    await stopWorker(handle);
    expect(execution.calls).toEqual([]);
    expect(servesWorker("api")).toBe(false);
  });

  it.each(["worker", "all"] as const)("starts and stops once for the %s role", async (role) => {
    const execution = recordingExecution();
    const handle = await startWorker({ role, execution, handlers });
    expect(handle).toEqual({ role, serving: true });
    expect(servesWorker(role)).toBe(true);
    await Promise.all([stopWorker(handle), stopWorker(handle)]);
    await stopWorker(handle);
    expect(execution.calls).toEqual(["start", "stop"]);
  });

  it("propagates a start failure", async () => {
    const execution = recordingExecution();
    execution.start = async () => {
      throw new Error("registration failed");
    };
    await expect(startWorker({ role: "all", execution, handlers })).rejects.toThrow(
      "registration failed",
    );
  });
});
