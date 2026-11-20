import assert from "node:assert/strict";
import test from "node:test";
import { attributeValue, formatSpanTime, traceLengthMs, traceRows, turnIdsOf } from "../web/src/turn-trace.ts";
import { EVENT_VIEWS, inView, writerOf } from "../web/src/event-layers.ts";

const at = (ms) => String(BigInt(1_700_000_000_000 + ms) * 1_000_000n);
const span = (spanId, parentSpanId, name, start, end, attributes = [], status = { code: 1 }) => ({
  traceId: "t".repeat(32),
  spanId,
  ...(parentSpanId ? { parentSpanId } : {}),
  name,
  kind: 1,
  startTimeUnixNano: at(start),
  endTimeUnixNano: at(end),
  attributes,
  status,
});
const s = (key, value) => ({ key, value: { stringValue: value } });
const i = (key, value) => ({ key, value: { intValue: String(value) } });
const trace = {
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "@nylorun/runtime" },
          spans: [
            span("tool", "root", "execute_tool bash", 2500, 4000, [s("gen_ai.operation.name", "execute_tool"), s("gen_ai.tool.name", "bash")]),
            span("chat2", "root", "chat gemini", 4100, 5200, [s("gen_ai.operation.name", "chat")], { code: 2, message: "rate limited" }),
            span("root", undefined, "invoke_agent bot", 0, 5300, [s("gen_ai.operation.name", "invoke_agent")]),
            span("chat1", "root", "chat gemini", 100, 2400, [
              s("gen_ai.operation.name", "chat"),
              s("gen_ai.request.model", "gemini-3.8-flash"),
              i("gen_ai.usage.input_tokens", 1200),
              i("gen_ai.usage.output_tokens", 80),
              s("nylorun.event.cursor", "c4"),
            ]),
          ],
        },
      ],
    },
  ],
};

test("a trace's spans become rows in tree order, timed from the turn's start", () => {
  const rows = traceRows(trace);
  assert.deepEqual(rows.map((r) => [r.spanId, r.depth, r.offsetMs, r.durationMs]), [
    ["root", 0, 0, 5300],
    ["chat1", 1, 100, 2300],
    ["tool", 1, 2500, 1500],
    ["chat2", 1, 4100, 1100],
  ]);
  const chat = rows[1];
  assert.equal(chat.operation, "chat");
  assert.equal(chat.model, "gemini-3.8-flash");
  assert.equal(chat.inputTokens, 1200);
  assert.equal(chat.outputTokens, 80);
  assert.equal(chat.cursor, "c4");
  assert.equal(rows[2].tool, "bash");
  assert.equal(rows[3].error, true);
  assert.equal(rows[3].errorMessage, "rate limited");
  assert.equal(traceLengthMs(rows), 5300);
});

test("an empty trace has no rows, and a span whose parent is missing is a root", () => {
  assert.deepEqual(traceRows({ resourceSpans: [] }), []);
  const orphan = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "x" }, spans: [span("a", "gone", "chat", 0, 10)] }] }] };
  assert.equal(traceRows(orphan)[0].depth, 0);
});

test("attribute values: plain, numbers from strings, structured as JSON", () => {
  assert.equal(attributeValue({ stringValue: "x" }), "x");
  assert.equal(attributeValue({ intValue: "42" }), 42);
  assert.equal(attributeValue({ boolValue: false }), false);
  assert.equal(attributeValue({ arrayValue: { values: [{ stringValue: "a" }] } }), '{"values":[{"stringValue":"a"}]}');
  assert.equal(attributeValue({}), undefined);
});

test("turns in the order they first appear, and span times", () => {
  assert.deepEqual(turnIdsOf([{ turnId: null }, { turnId: "a" }, { turnId: "b" }, { turnId: "a" }]), ["a", "b"]);
  assert.equal(formatSpanTime(850), "850 ms");
  assert.equal(formatSpanTime(3240), "3.2 s");
  assert.equal(formatSpanTime(42_000), "42 s");
  assert.equal(formatSpanTime(125_000), "2 min 5 s");
});

test("the Events views split on each type's layer (ADR-159)", () => {
  assert.deepEqual(EVENT_VIEWS.map((v) => v.value), ["agent", "runtime", "all"]);
  assert.equal(inView("message.assistant", "agent"), true);
  assert.equal(inView("message.assistant", "runtime"), false);
  assert.equal(inView("queue.taken", "runtime"), true);
  assert.equal(inView("queue.taken", "agent"), false);
  // A type this Studio doesn't know shows only under All.
  assert.equal(inView("future.type", "agent"), false);
  assert.equal(inView("future.type", "runtime"), false);
  assert.equal(inView("future.type", "all"), true);
  assert.equal(writerOf({ source: { kind: "loop", id: "h" }, evidence: "claimed" }), "loop · claimed");
  assert.equal(writerOf({ source: { kind: "api", id: "core" } }), "api");
});
