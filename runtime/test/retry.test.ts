/** The shared wait and retry helpers (`src/retry.ts`). */
import { expect, it } from "vitest";
import { retry, sleep } from "../src/retry.js";

it("sleeps until the time is up or the signal aborts, and never rejects", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let started = Date.now();
  await sleep(10_000, aborted.signal);
  expect(Date.now() - started).toBeLessThan(50);

  const later = new AbortController();
  started = Date.now();
  setTimeout(() => later.abort(), 20);
  await sleep(10_000, later.signal);
  expect(Date.now() - started).toBeLessThan(500);

  started = Date.now();
  await sleep(30);
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
});

it("retries with doubling waits until the attempt succeeds", async () => {
  const at: number[] = [];
  const failures: number[] = [];
  const value = await retry(
    async () => {
      at.push(Date.now());
      if (at.length < 4) throw new Error(`fail ${at.length}`);
      return "ok";
    },
    { minMs: 10, maxMs: 25, onError: (_error, n) => failures.push(n) },
  );
  expect(value).toBe("ok");
  expect(failures).toEqual([1, 2, 3]);
  const waits = at.slice(1).map((time, i) => time - at[i]!);
  expect(waits[0]).toBeGreaterThanOrEqual(8);
  expect(waits[2]).toBeGreaterThanOrEqual(20);
});

it("gives up with the last failure after its attempts, its deadline, or an abort", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error(`fail ${calls}`);
  };
  await expect(retry(failing, { minMs: 1, maxMs: 1, attempts: 3 })).rejects.toThrow("fail 3");

  calls = 0;
  const started = Date.now();
  await expect(retry(failing, { minMs: 20, maxMs: 20, deadlineMs: 50 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(200);
  expect(calls).toBeGreaterThanOrEqual(2);

  calls = 0;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await expect(retry(failing, { minMs: 10_000, maxMs: 10_000, signal: stop.signal })).rejects.toThrow("fail 1");
  expect(calls).toBe(1);
});
