import { describe, expect, it } from "vitest";
import {
  EVENT_CATALOG,
  EVENT_SCHEMAS,
  EVENT_TYPES,
  SessionEventSchema,
  parseSessionEvent,
} from "../src/contracts.js";

const envelope = {
  schema: "nylorun.event/2",
  eventId: "ev_1",
  sessionId: "s1",
  tenantId: "tn_1",
  runId: null,
  turnId: "turn_1",
  incarnation: 0,
  epoch: 1,
  seq: 4,
  cursor: "czE6NA",
  time: "2026-10-01T00:00:00.000Z",
  schemaVersion: 1,
  source: { kind: "loop", id: "runtime" },
  evidence: "observed",
  visibility: "public",
  retention: "full",
} as const;

describe("event catalog", () => {
  it("has one schema per type, each typing its own literal", () => {
    expect(Object.keys(EVENT_SCHEMAS)).toEqual(EVENT_TYPES);
    for (const type of EVENT_TYPES)
      expect(EVENT_SCHEMAS[type].shape.type.value).toBe(type);
    expect(EVENT_TYPES).toContain("sandbox.exec");
    expect(EVENT_TYPES).not.toContain("node.completed");
  });

  it("types a known event and keeps unknown payload fields", () => {
    const event = parseSessionEvent({
      ...envelope,
      type: "action.delivered",
      payload: { actionId: "a1", generation: 2, extra: true },
    });
    expect(event.type).toBe("action.delivered");
    expect(event.payload).toEqual({ actionId: "a1", generation: 2, extra: true });
  });

  it("reads a type it does not know as the bare envelope", () => {
    const event = parseSessionEvent({ ...envelope, type: "future.thing", payload: { x: 1 } });
    expect(event).toMatchObject({ type: "future.thing", payload: { x: 1 }, seq: 4 });
  });

  it("strips envelope fields it does not know, so the envelope can grow", () => {
    const event = parseSessionEvent({
      ...envelope,
      addedLater: "x",
      type: "turn.completed",
      payload: { output: 1 },
    });
    expect(event).not.toHaveProperty("addedLater");
  });

  it("rejects a known type whose payload does not match", () => {
    expect(
      SessionEventSchema.safeParse({ ...envelope, type: "loop.decided", payload: { n: 1 } })
        .success
    ).toBe(false);
  });

  it("names a source and a version for every type", () => {
    for (const type of EVENT_TYPES) {
      expect(["loop", "api"]).toContain(EVENT_CATALOG[type].source);
      expect(EVENT_CATALOG[type].version).toBeGreaterThan(0);
    }
  });
});
