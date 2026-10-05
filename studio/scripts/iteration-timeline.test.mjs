import assert from "node:assert/strict";
import test from "node:test";
import {
  groupIterationsByPath,
  iterationTimelineFromEvents,
} from "../web/src/workflow/iteration-timeline.ts";

/** Recorded loop.* fixtures (loops.md §4.6): a body turn, then its verifier's verdict. */
const fixtures = [
  {
    type: "loop.iteration",
    payload: {
      path: "fix-tests",
      n: 1,
      sessionId: "s-coder",
      turnId: "t1",
      manifestHash: "hash-a",
    },
  },
  {
    type: "loop.verified",
    payload: {
      path: "fix-tests",
      n: 1,
      pass: false,
      feedback: "try again",
    },
  },
  {
    type: "loop.iteration",
    payload: {
      path: "fix-tests",
      n: 2,
      sessionId: "s-coder",
      turnId: "t2",
      manifestHash: "hash-a",
    },
  },
  {
    type: "loop.verified",
    payload: { path: "fix-tests", n: 2, pass: true },
  },
];

test("LOOP-EV5: iteration timeline keeps count and verdicts", () => {
  const rows = iterationTimelineFromEvents(fixtures);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.n, 1);
  assert.equal(rows[0]?.sessionId, "s-coder");
  assert.equal(rows[0]?.pass, false);
  assert.equal(rows[0]?.feedback, "try again");
  assert.equal(rows[1]?.n, 2);
  assert.equal(rows[1]?.turnId, "t2");
  assert.equal(rows[1]?.pass, true);
  const groups = groupIterationsByPath(rows);
  assert.equal(groups.get("fix-tests")?.length, 2);
});

test("filters to one Loop path", () => {
  const rows = iterationTimelineFromEvents(
    [...fixtures, { type: "loop.iteration", payload: { path: "other", n: 1 } }],
    { path: "other" },
  );
  assert.deepEqual(rows, [{ n: 1, path: "other" }]);
});
