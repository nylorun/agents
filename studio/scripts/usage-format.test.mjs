import assert from "node:assert/strict";
import test from "node:test";
import { formatCost, formatTokens, usageNotes } from "../web/src/usage-format.ts";

test("formatTokens and formatCost read at a glance", () => {
  assert.equal(formatTokens(1234567), "1,234,567");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatCost(0.0123), "$0.01");
  assert.equal(formatCost(0.00456), "$0.0046");
  assert.equal(formatCost(0.00001), "<$0.0001");
});

test("usageNotes says what the totals count twice or leave out", () => {
  assert.deepEqual(usageNotes({ duplicates: 0, unpricedCalls: 0, unreportedCalls: 0 }), []);
  assert.deepEqual(usageNotes({ duplicates: 1, unpricedCalls: 2, unreportedCalls: 3 }), [
    "1 model call was sent twice; both sends were billed and are counted.",
    "3 model calls reported no tokens and count as 0.",
    "2 model calls have no known price and cost $0 here.",
  ]);
  assert.deepEqual(usageNotes({ duplicates: 2, unpricedCalls: 1, unreportedCalls: 1 }), [
    "2 model calls were sent twice; both sends were billed and are counted.",
    "1 model call reported no tokens and counts as 0.",
    "1 model call has no known price and costs $0 here.",
  ]);
});
