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

it("forgets dedupe keys after the retention window", async () => {
  const execution = new MemoryExecution({ dedupeRetentionMs: 30 });
  let calls = 0;
  await execution.start({
    advance: async () => {
      calls += 1;
      return { status: "done" };
    },
    sweep: async () => {},
  });
  const wake = { reason: "message" as const, dedupeKey: "k" };
  await execution.wake("tn_x", "s1", wake);
  await execution.idle();
  await execution.wake("tn_x", "s1", wake);
  await execution.idle();
  expect(calls).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await execution.wake("tn_x", "s1", wake);
  await execution.idle();
  expect(calls).toBe(2);
  await execution.stop();
});

it("rejects an unknown wake reason", async () => {
  const execution = new MemoryExecution();
  await expect(
    execution.wake("tn_x", "s1", { reason: "nope" as never }),
  ).rejects.toThrow("Unknown wake reason");
});

it("stops within its grace when an advance ignores its abort, and abandons it", async () => {
  const execution = new MemoryExecution({ stopGraceMs: 150 });
  let entered = false;
  let calls = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await execution.start({
    // Ignores its signal; asks to run again, as an abandoned advance answers `busy`.
    advance: async () => {
      calls += 1;
      entered = true;
      await released;
      return { status: "busy", retryAfterMs: 0 };
    },
    sweep: async () => {},
  });
  await execution.wake("tn_x", "s1", { reason: "message" });
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));

  const started = Date.now();
  await execution.stop();
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(140);
  expect(took).toBeLessThan(2_000);

  // The abandoned advance ends later; a stopped execution does not run it again.
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(1);
});
