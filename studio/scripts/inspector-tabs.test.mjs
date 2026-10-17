import assert from "node:assert/strict";
import test from "node:test";
import { inspectorPlace } from "../web/src/inspector-tabs.ts";

test("a session opens on Events: an agent's log, a workflow's progress", () => {
  assert.deepEqual(inspectorPlace(null, null, false), { tab: "events", manifestView: "declared", eventsView: "log" });
  assert.deepEqual(inspectorPlace(null, null, true), { tab: "events", manifestView: "declared", eventsView: "progress" });
  assert.equal(inspectorPlace("nonsense", null, false).tab, "events");
});

test("the four tabs and their views come from ?inspector= and ?view=", () => {
  assert.equal(inspectorPlace("manifest", null, false).manifestView, "declared");
  assert.deepEqual(inspectorPlace("manifest", "deployed", false), {
    tab: "manifest",
    manifestView: "deployed",
    eventsView: "log",
  });
  assert.equal(inspectorPlace("record", null, false).tab, "record");
  assert.equal(inspectorPlace("usage", null, false).tab, "usage");
  assert.equal(inspectorPlace("events", "iterations", true).eventsView, "iterations");
  assert.equal(inspectorPlace("events", "log", true).eventsView, "log");
  // An agent session has no workflow views.
  assert.equal(inspectorPlace("events", "progress", false).eventsView, "log");
});

test("the tab names before the four tabs keep working", () => {
  for (const old of ["agent", "environment"])
    assert.deepEqual(inspectorPlace(old, null, false), { tab: "manifest", manifestView: "deployed", eventsView: "log" });
  assert.equal(inspectorPlace("artifacts", null, false).tab, "record");
  assert.deepEqual(inspectorPlace("tree", null, true), { tab: "events", manifestView: "declared", eventsView: "progress" });
  assert.deepEqual(inspectorPlace("iterations", null, true), {
    tab: "events",
    manifestView: "declared",
    eventsView: "iterations",
  });
  assert.equal(inspectorPlace("iterations", null, false).eventsView, "log");
});
