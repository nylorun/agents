/**
 * Waiting for the advances running on this process (`tenant/scheduler.ts`): close and drain
 * settle when the last one ends, not on a poll, and give up after their timeout.
 */
import { expect, it } from "vitest";
import type { TenantContext } from "../../src/tenant/context.js";
import { createWorkState, drain, endAdvance, waitForIdle } from "../../src/tenant/scheduler.js";

function contextOf() {
  const warnings: unknown[] = [];
  const ctx = {
    closing: false,
    work: createWorkState(),
    config: { logger: { info() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} } },
  } as unknown as TenantContext;
  return { ctx, warnings };
}

it("settles when the last advance ends, not before", async () => {
  const { ctx } = contextOf();
  const a = new AbortController();
  const b = new AbortController();
  ctx.work.running.set("s1", a);
  ctx.work.running.set("s2", b);
  let settled = false;
  const waiting = waitForIdle(ctx, 60_000).then((abandoned) => {
    settled = true;
    return abandoned;
  });
  endAdvance(ctx.work, "s1", a);
  // A controller a later advance of the session replaced ends nothing.
  endAdvance(ctx.work, "s2", new AbortController());
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  const started = Date.now();
  endAdvance(ctx.work, "s2", b);
  expect(await waiting).toEqual([]);
  expect(Date.now() - started).toBeLessThan(50);
  expect(ctx.work.idleWaiters.size).toBe(0);
});

it("gives up after its timeout and names the advances still running", async () => {
  const { ctx, warnings } = contextOf();
  ctx.work.running.set("stuck", new AbortController());
  const started = Date.now();
  expect(await waitForIdle(ctx, 100)).toEqual(["stuck"]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  expect(warnings).toHaveLength(1);
  expect(ctx.work.idleWaiters.size).toBe(0);
});

it("drains at once when nothing runs, and stops new advances", async () => {
  const { ctx } = contextOf();
  const started = Date.now();
  await drain(ctx, "drain", 60_000);
  expect(Date.now() - started).toBeLessThan(50);
  expect(ctx.closing).toBe(true);
});
