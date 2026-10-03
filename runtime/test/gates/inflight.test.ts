/**
 * Keyed model calls in the gates service (`gates/inflight.ts`, P1.2): a call outlives its
 * client, a re-send joins it or gets its outcome, a different request under the same key is a
 * conflict, and outcomes expire.
 */
import { describe, expect, it } from "vitest";
import { createInflightCalls, InflightConflict, InflightStale } from "../../src/gates/inflight.js";
import type { ModelGateOutcome } from "../../src/gates/model-gate.js";

const answer = (text: string): ModelGateOutcome => ({
  output: [{ type: "text", text }],
  finishReason: "stop",
});

/** A call the test settles by hand, counting how often it was started. */
function held() {
  let starts = 0;
  let settle!: (outcome: ModelGateOutcome) => void;
  let signal!: AbortSignal;
  const start = (own: AbortSignal) => {
    starts += 1;
    signal = own;
    return new Promise<ModelGateOutcome>((resolve, reject) => {
      settle = resolve;
      own.addEventListener("abort", () => reject(own.reason), { once: true });
    });
  };
  return { start, settle: (o: ModelGateOutcome) => settle(o), starts: () => starts, signal: () => signal };
}

describe("InflightCalls", () => {
  it("joins a running call with the same key and request, starting it once", async () => {
    const calls = createInflightCalls();
    const call = held();
    const first = calls.run("t:e1", "h1", call.start);
    const second = calls.run("t:e1", "h1", call.start);
    call.settle(answer("once"));
    expect(await first).toEqual(answer("once"));
    expect(await second).toEqual(answer("once"));
    expect(call.starts()).toBe(1);
  });

  it("returns a settled outcome to a later re-send, until the TTL", async () => {
    let now = 0;
    const calls = createInflightCalls({ ttlMs: 1000, now: () => now });
    const call = held();
    const first = calls.run("t:e1", "h1", call.start);
    call.settle(answer("kept"));
    await first;
    now = 999;
    expect(await calls.run("t:e1", "h1", call.start)).toEqual(answer("kept"));
    expect(call.starts()).toBe(1);
    now = 1000;
    const again = calls.run("t:e1", "h1", call.start);
    expect(call.starts()).toBe(2);
    call.settle(answer("again"));
    expect(await again).toEqual(answer("again"));
  });

  it("refuses a different request under the same key", async () => {
    const calls = createInflightCalls();
    const call = held();
    void calls.run("t:e1", "h1", call.start);
    await expect(calls.run("t:e1", "h2", call.start)).rejects.toBeInstanceOf(InflightConflict);
  });

  it("cancels a running call and forgets it; an abort is not kept", async () => {
    const calls = createInflightCalls();
    const call = held();
    const running = calls.run("t:e1", "h1", call.start);
    calls.cancel("t:e1");
    await expect(running).rejects.toThrow(/cancelled/);
    expect(call.signal().aborted).toBe(true);
    expect(calls.size).toBe(0);
    calls.cancel("t:missing");
  });

  it("forgets a call whose start rejects, so a re-send runs it again", async () => {
    const calls = createInflightCalls();
    let starts = 0;
    const failing = async () => {
      starts += 1;
      throw new Error("boom");
    };
    await expect(calls.run("t:e1", "h1", failing)).rejects.toThrow("boom");
    await expect(calls.run("t:e1", "h1", failing)).rejects.toThrow("boom");
    expect(starts).toBe(2);
  });

  it("drops the oldest settled outcomes beyond max, never a running call", async () => {
    const calls = createInflightCalls({ max: 2 });
    for (const key of ["a", "b"]) await calls.run(key, "h", async () => answer(key));
    const running = held();
    void calls.run("c", "h", running.start);
    void calls.run("d", "h", held().start);
    expect(calls.size).toBe(3);
    running.settle(answer("c"));
  });

  it("joins a run's call only for its session, at the same or a newer epoch (F5, G4)", async () => {
    const calls = createInflightCalls();
    const call = held();
    const first = calls.run("t:e1", "h1", call.start, { sessionId: "s1", epoch: 2 });
    await expect(calls.run("t:e1", "h1", call.start, { sessionId: "s2", epoch: 9 })).rejects.toThrow(
      InflightConflict,
    );
    // The new owner after a takeover joins; from then on the old owner is behind.
    const joined = calls.run("t:e1", "h1", call.start, { sessionId: "s1", epoch: 3 });
    await expect(calls.run("t:e1", "h1", call.start, { sessionId: "s1", epoch: 2 })).rejects.toThrow(
      InflightStale,
    );
    call.settle(answer("once"));
    expect(await first).toEqual(answer("once"));
    expect(await joined).toEqual(answer("once"));
    expect(call.starts()).toBe(1);
  });

  it("cancels a run's call only for its own session", async () => {
    const calls = createInflightCalls();
    const call = held();
    const running = calls.run("t:e1", "h1", call.start, { sessionId: "s1", epoch: 1 });
    expect(calls.cancel("t:e1", "s2")).toBe(false);
    expect(call.signal().aborted).toBe(false);
    expect(calls.cancel("t:e1", "s1")).toBe(true);
    await expect(running).rejects.toThrow(/cancelled/);
    expect(calls.cancel("t:missing", "s2")).toBe(true);
  });

  it("aborts running calls on close", async () => {
    const calls = createInflightCalls();
    const call = held();
    const running = calls.run("t:e1", "h1", call.start);
    calls.close();
    await expect(running).rejects.toThrow(/shutting down/);
    expect(calls.size).toBe(0);
  });
});
