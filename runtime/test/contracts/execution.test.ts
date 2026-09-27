import { expect, it } from "vitest";
import { MemoryExecution } from "../../src/execution/memory.js";
import { parseSessionKey, sessionKey } from "../../src/execution/types.js";
import { executionContract } from "./execution.contract.js";

executionContract("memory", async ({ sweepIntervalMs }) => ({
  execution: new MemoryExecution({ sweepIntervalMs, retryDelayMs: 20 }),
}));

it("round-trips session keys", () => {
  expect(parseSessionKey(sessionKey("tn_x", "s:1"))).toEqual({
    tenantId: "tn_x",
    sessionId: "s:1",
  });
  expect(() => parseSessionKey("nokey")).toThrow();
});

it("holds wakes until start and reports exhausted retries", async () => {
  const errors: unknown[] = [];
  const execution = new MemoryExecution({
    retryDelayMs: 1,
    maxAttempts: 3,
    onError: (error) => errors.push(error),
  });
  let calls = 0;
  await execution.wake("tn_x", "s1", { reason: "message" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(0);
  await execution.start({
    advance: async () => {
      calls += 1;
      throw new Error("down");
    },
    sweep: async () => {},
  });
  await execution.idle();
  expect(calls).toBe(3);
  expect(errors).toHaveLength(1);
  await execution.stop();
});

it("rejects an unknown wake reason", async () => {
  const execution = new MemoryExecution();
  await expect(
    execution.wake("tn_x", "s1", { reason: "nope" as never }),
  ).rejects.toThrow("Unknown wake reason");
});
