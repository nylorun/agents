import assert from "node:assert/strict";
import test from "node:test";
import {
  callEvents,
  durationOf,
  formatDuration,
  formatShare,
  ledgerCost,
  sessionLedger,
  turnsOf,
} from "../web/src/usage-ledger.ts";

const usage = (cached, input, output, costUsd, costSplit = null) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: cached + input + output,
  cachedTokens: cached,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd,
  costSplit,
});

const totals = (extra = {}) => ({
  ...usage(129_286, 60_675, 5_633, 0.0501),
  calls: 17,
  costSplit: { input: 0.0358, cacheRead: 0.0076, cacheWrite: 0, output: 0.0067 },
  splitCalls: 17,
  modelTimeMs: 97_600,
  timedCalls: 17,
  ...extra,
});

test("sessionLedger splits tokens and cost by kind, and its rows add up to the total", () => {
  const ledger = sessionLedger(totals());
  assert.deepEqual(
    ledger.parts.map((p) => [p.label, p.tokens, formatShare(p.tokenShare), p.cost, formatShare(p.costShare)]),
    [
      ["Cached input", 129_286, "66%", 0.0076, "15%"],
      ["Uncached input", 60_675, "31%", 0.0358, "71%"],
      ["Output", 5_633, "3%", 0.0067, "13%"],
    ],
  );
  assert.equal(ledger.totalTokens, 195_594);
  assert.equal(ledger.totalCost, 0.0501);
  assert.equal(ledger.unsplitCost, 0);
});

test("sessionLedger shows cache write only when the session wrote to the cache", () => {
  const wrote = sessionLedger(totals({ cacheWriteTokens: 4_000 }));
  assert.deepEqual(
    wrote.parts.map((p) => p.kind),
    ["cacheRead", "input", "cacheWrite", "output"],
  );
  assert.equal(wrote.totalTokens, 199_594);
});

test("sessionLedger counts cost from before the split in the total only", () => {
  const none = sessionLedger(totals({ splitCalls: 0, costSplit: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }));
  assert.deepEqual(
    none.parts.map((p) => [p.cost, p.costShare]),
    [
      [null, null],
      [null, null],
      [null, null],
    ],
  );
  assert.equal(none.unsplitCost, 0);
  const some = sessionLedger(totals({ splitCalls: 9, costSplit: { input: 0.02, cacheRead: 0.005, cacheWrite: 0, output: 0.004 } }));
  assert.ok(Math.abs(some.unsplitCost - 0.0211) < 1e-12);
});

test("turnsOf groups calls by turn in ledger order, with the same sums at each level", () => {
  const calls = [
    { id: "c1", effectId: "t1:0:model:1", turnId: "t1", at: "2026-10-17T14:43:02Z", startedAt: "2026-10-17T14:43:00.000Z", endedAt: "2026-10-17T14:43:02.000Z", usage: usage(0, 2_213, 62, 0.0015) },
    { id: "c2", effectId: "t2:0:model:1", turnId: "t2", at: "2026-10-17T14:45:01Z", startedAt: null, endedAt: null, usage: usage(0, 6_213, 111, 0.004) },
    { id: "c3", effectId: "t1:0:model:2", turnId: "t1", at: "2026-10-17T14:43:06Z", startedAt: "2026-10-17T14:43:03.000Z", endedAt: "2026-10-17T14:43:06.500Z", usage: usage(2_275, 3_199, 449, 0.003) },
    { id: "c4", effectId: "t2:0:model:2", turnId: "t2", at: "2026-10-17T14:45:09Z", startedAt: null, endedAt: null, usage: null },
  ];
  const turns = turnsOf(calls);
  assert.deepEqual(
    turns.map((t) => [t.turnId, t.number, t.start, t.calls.map((c) => c.number), t.tokens, t.total, t.durationMs]),
    [
      ["t1", 1, "2026-10-17T14:43:00.000Z", [1, 3], { cacheRead: 2_275, input: 5_412, cacheWrite: 0, output: 511 }, 8_198, 5_500],
      ["t2", 2, "2026-10-17T14:45:01Z", [2, 4], { cacheRead: 0, input: 6_213, cacheWrite: 0, output: 111 }, 6_324, null],
    ],
  );
  assert.ok(Math.abs(turns[0].cost - 0.0045) < 1e-12);
  assert.equal(turns[1].calls[1].recorded, false);
  assert.equal(turns[1].calls[1].total, 0);
});

test("durationOf and formatDuration read at a glance", () => {
  assert.equal(durationOf({ startedAt: "2026-10-17T14:43:00.000Z", endedAt: "2026-10-17T14:43:04.200Z" }), 4_200);
  assert.equal(durationOf({ startedAt: null, endedAt: "2026-10-17T14:43:04.200Z" }), null);
  assert.equal(durationOf({ startedAt: "2026-10-17T14:43:05Z", endedAt: "2026-10-17T14:43:04Z" }), null);
  assert.equal(formatDuration(420), "0.4s");
  assert.equal(formatDuration(12_340), "12.3s");
  assert.equal(formatDuration(97_600), "1m 38s");
  assert.equal(formatDuration(3_725_000), "1h 02m");
});

test("callEvents finds each call's event by effect id, its message.assistant first", () => {
  const events = [
    { type: "context.compacted", payload: { effectId: "e1" } },
    { type: "message.assistant", payload: { effectId: "e1" } },
    { type: "model.failed", payload: { effectId: "e2" } },
    { type: "tool.completed", payload: { effectId: "e3" } },
    { type: "message.assistant", payload: null },
  ];
  const found = callEvents(events);
  assert.equal(found.get("e1"), events[1]);
  assert.equal(found.get("e2"), events[2]);
  assert.equal(found.has("e3"), false);
  assert.equal(found.size, 2);
});

test("ledgerCost gives every cost in a ledger the same precision", () => {
  const small = ledgerCost(0.0501);
  assert.deepEqual([0.0501, 0.04, 0.0052, 0].map(small), ["$0.0501", "$0.0400", "$0.0052", "$0.0000"]);
  const large = ledgerCost(12.5);
  assert.deepEqual([12.5, 0.0052].map(large), ["$12.50", "$0.01"]);
});
