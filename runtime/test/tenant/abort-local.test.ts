/**
 * `abortLocal` with a turn: a cancel signal names the turn it cancelled, so one that arrives
 * late (its append retried after S2 came back) never stops an advance of a later turn.
 */
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../../src/tenant/context.js";
import { abortLocal, createWorkState } from "../../src/tenant/scheduler.js";

function running(turnId: string | null) {
  const work = createWorkState();
  const controller = new AbortController();
  work.running.set("s1", controller);
  work.runningTurns.set("s1", turnId);
  return { ctx: { work } as unknown as TenantContext, controller };
}

describe("abortLocal", () => {
  it("aborts the advance of the cancelled turn", () => {
    const { ctx, controller } = running("t1");
    abortLocal(ctx, "s1", "cancel", "t1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("leaves an advance of a later turn running", () => {
    const { ctx, controller } = running("t2");
    abortLocal(ctx, "s1", "cancel", "t1");
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts whatever runs when no turn is named", () => {
    const { ctx, controller } = running("t2");
    abortLocal(ctx, "s1");
    expect(controller.signal.aborted).toBe(true);
  });
});
