/** Trace ids (R7.2, Q3) and trace context in (R7.4). */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  effectSpanOf,
  egressSpanOf,
  parseTraceparent,
  traceContextOf,
  traceIdOf,
  traceparentOf,
  turnSpanOf,
} from "../../src/traces/ids.js";
import { traceKey } from "../../src/traces/key.js";
import { createTestSessionStore } from "../support/store.js";

const key = randomBytes(32);
const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

describe("trace ids", () => {
  it("are the same twice, and differ by key, turn and effect", () => {
    expect(traceIdOf(key, "tn", "s", "t")).toBe(traceIdOf(key, "tn", "s", "t"));
    expect(traceIdOf(key, "tn", "s", "t")).toMatch(/^[0-9a-f]{32}$/);
    expect(turnSpanOf(key, "t")).toMatch(/^[0-9a-f]{16}$/);
    expect(traceIdOf(randomBytes(32), "tn", "s", "t")).not.toBe(traceIdOf(key, "tn", "s", "t"));
    expect(traceIdOf(key, "tn", "s", "t2")).not.toBe(traceIdOf(key, "tn", "s", "t"));
    expect(effectSpanOf(key, "t:0:tool:a")).not.toBe(effectSpanOf(key, "t:0:tool:b"));
    expect(egressSpanOf(key, "s", 4)).not.toBe(egressSpanOf(key, "s", 5));
  });

  it("reads a valid traceparent and ignores a malformed one", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceparent(traceparent)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    for (const bad of [
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
      "garbage",
    ])
      expect(parseTraceparent(bad)).toBeUndefined();
    expect(traceContextOf(headers({ traceparent, tracestate: "vendor=1" }))).toEqual({
      traceparent,
      tracestate: "vendor=1",
    });
    expect(traceContextOf(headers({ traceparent: "bad", tracestate: "vendor=1" }))).toBeUndefined();
    expect(traceContextOf(headers({ traceparent, tracestate: "x".repeat(600) }))).toEqual({ traceparent });
    expect(traceparentOf("a".repeat(32), "b".repeat(16))).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  it("keeps one trace key per Tenant, created once", async () => {
    const store = await createTestSessionStore();
    const [a, b] = await Promise.all([traceKey(store), traceKey(store)]);
    expect(a.length).toBe(32);
    expect(b.equals(a)).toBe(true);
    const setting = await store.tx((t) => t.getSetting("trace.key"));
    expect(Buffer.from(setting!, "base64").equals(a)).toBe(true);
  });
});
