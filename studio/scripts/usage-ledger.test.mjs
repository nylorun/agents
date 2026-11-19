import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheShare,
  callEvents,
  callFacts,
  chartBar,
  compactTokens,
  compactionsOf,
  contextCalls,
  contextOf,
  contextSummary,
  latestContext,
  subagentsOf,
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

const withWrite = (cached, input, write, output, costUsd, costSplit = null) => ({
  ...usage(cached, input, output, costUsd, costSplit),
  totalTokens: cached + input + write + output,
  cacheWriteTokens: write,
});
const modelCall = (n, turnId, u) => ({
  id: `c${n}`,
  effectId: `e${n}`,
  turnId,
  at: `2026-11-19T10:00:${String(n).padStart(2, "0")}Z`,
  startedAt: null,
  endedAt: null,
  usage: u,
});
const event = (type, effectId, extra = {}) => ({ type, seq: 0, payload: { effectId, ...extra } });

/** A session: two root calls, a subagent's two calls in one run, a compaction, a root call after it. */
function session() {
  const calls = [
    modelCall(1, "t1", withWrite(0, 4_812, 4_120, 312, 0.03)),
    modelCall(2, "t1", withWrite(8_932, 1_204, 0, 486, 0.01)),
    modelCall(3, "t1", withWrite(0, 2_000, 1_000, 100, 0.002, { input: 0.001, cacheRead: 0, cacheWrite: 0.0008, output: 0.0002 })),
    modelCall(4, "t1", withWrite(3_000, 500, 0, 80, 0.001)),
    modelCall(5, "t2", withWrite(10_622, 0, 0, 900, 0.02)),
    modelCall(6, "t2", withWrite(2_000, 1_500, 0, 400, 0.005)),
  ];
  const sub = { id: "charts", path: "analyst/charts", delegationId: "d1" };
  const events = [
    event("message.assistant", "e1"),
    event("message.assistant", "e2"),
    event("message.assistant", "e3", { agent: sub }),
    event("message.assistant", "e4", { agent: sub }),
    event("context.compacted", "e5", { trigger: "threshold", tokensBefore: 9_000, tokensAfter: 2_000 }),
    event("message.assistant", "e6"),
    { type: "delegation.started", seq: 0, payload: { agent: sub } },
  ];
  const rows = contextCalls(turnsOf(calls), callFacts(callEvents(events)));
  return { calls, events, rows };
}

test("contextOf is the input the call sent: cached, uncached and cache write, not the output", () => {
  assert.equal(contextOf({ cacheRead: 8_932, input: 1_204, cacheWrite: 50, output: 486 }), 10_186);
});

test("callFacts names a subagent's calls and the compaction summary", () => {
  const { rows } = session();
  assert.deepEqual(
    rows.map((r) => [r.number, r.context, r.facts.agentPath ?? null, r.facts.summary]),
    [
      [1, 8_932, null, false],
      [2, 10_136, null, false],
      [3, 3_000, "analyst/charts", false],
      [4, 3_500, "analyst/charts", false],
      [5, 10_622, null, true],
      [6, 3_500, null, false],
    ],
  );
  assert.equal(rows[4].facts.trigger, "threshold");
});

test("contextSummary reads the root agent's last and largest call, skipping subagents and summaries", () => {
  const summary = contextSummary(session().rows);
  assert.equal(summary.last.number, 6);
  assert.equal(summary.last.context, 3_500);
  assert.equal(summary.peak.number, 2);
  assert.deepEqual(summary.series, [8_932, 10_136, 3_500]);
  assert.equal(contextSummary([]), null);
});

test("compactionsOf measures the context on the root agent's calls either side, not the event's estimate", () => {
  const [compaction] = compactionsOf(session().rows);
  assert.equal(compaction.summary.number, 5);
  assert.equal(compaction.trigger, "threshold");
  assert.equal(compaction.before, 10_136);
  assert.equal(compaction.after, 3_500);
  const { rows } = session();
  assert.equal(compactionsOf(rows.slice(0, 5))[0].after, null);
});

test("subagentsOf adds up each subagent's calls, with its runs from delegation.started", () => {
  const { rows, events } = session();
  const [charts] = subagentsOf(rows, events);
  assert.equal(charts.path, "analyst/charts");
  assert.equal(charts.runs, 1);
  assert.equal(charts.calls, 2);
  assert.equal(charts.peakContext, 3_500);
  assert.equal(charts.tokens, 3_100 + 3_580);
  assert.ok(Math.abs(charts.cost - 0.003) < 1e-12);
  // Without delegation.started, the delegations its calls name count its runs.
  assert.equal(subagentsOf(rows, [])[0].runs, 1);
});

test("chartBar measures a call in tokens or in cost by kind; an unsplit cost stays whole", () => {
  const { rows } = session();
  assert.deepEqual(chartBar(rows[0], "tokens").segments, { cacheRead: 0, input: 4_812, cacheWrite: 4_120, output: 312 });
  assert.equal(chartBar(rows[0], "tokens").total, 9_244);
  const split = chartBar(rows[2], "cost");
  assert.equal(split.unsplit, 0);
  assert.ok(Math.abs(split.total - 0.002) < 1e-12);
  const unsplit = chartBar(rows[0], "cost");
  assert.equal(unsplit.unsplit, 0.03);
  assert.equal(unsplit.total, 0.03);
});

test("cacheShare is the share of the input read from the cache", () => {
  assert.equal(cacheShare({ cachedTokens: 75, inputTokens: 20, cacheWriteTokens: 5 }), 0.75);
  assert.equal(cacheShare({ cachedTokens: 0, inputTokens: 0, cacheWriteTokens: 0 }), null);
});

test("latestContext reads the root agent's newest message.assistant usage, in either order", () => {
  const usageOf = (seq, input, cached, write, agent) => ({
    type: "message.assistant",
    seq,
    payload: { usage: { inputTokens: input, cachedTokens: cached, cacheWriteTokens: write, outputTokens: 9 }, ...(agent ? { agent } : {}) },
  });
  const events = [
    usageOf(3, 100, 900, 0),
    usageOf(5, 50, 1_000, 200, { id: "s", path: "a/s" }),
    usageOf(4, 1_150, 16_090, 0),
    { type: "turn.completed", seq: 6, payload: {} },
  ];
  assert.equal(latestContext(events), 17_240);
  assert.equal(latestContext([...events].reverse()), 17_240);
  assert.equal(latestContext([]), null);
});

test("compactTokens reads at a glance", () => {
  assert.deepEqual([912, 17_240, 184_900, 1_250_000].map(compactTokens), ["912", "17.2k", "185k", "1.3M"]);
});
