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
  it("never starts the execution without the loop service", async () => {
    const execution = recordingExecution();
    const services = new Set(["core"] as const);
    const handle = await startWorker({ services, execution, handlers });
    expect(handle).toEqual({ services, serving: false });
    await stopWorker(handle);
    expect(execution.calls).toEqual([]);
    expect(servesWorker(services)).toBe(false);
  });

  it.each([["loop"], ["core", "loop"]] as const)("starts and stops once for %j", async (...names) => {
    const execution = recordingExecution();
    const services = new Set<"core" | "loop">(names);
    const handle = await startWorker({ services, execution, handlers });
    expect(handle).toEqual({ services, serving: true });
    expect(servesWorker(services)).toBe(true);
    await Promise.all([stopWorker(handle), stopWorker(handle)]);
    await stopWorker(handle);
    expect(execution.calls).toEqual(["start", "stop"]);
  });

  it("propagates a start failure", async () => {
    const execution = recordingExecution();
    execution.start = async () => {
      throw new Error("registration failed");
    };
    await expect(
      startWorker({ services: new Set(["core", "loop"] as const), execution, handlers }),
    ).rejects.toThrow(
      "registration failed",
    );
  });
});
