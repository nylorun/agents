import assert from "node:assert/strict";
import test from "node:test";
import { eventExport, eventExportName } from "../web/src/event-export.ts";

const event = {
  schema: "nylorun.event.v1",
  eventId: "e1",
  tenantId: "t",
  sessionId: "s1",
  runId: null,
  turnId: "turn1",
  incarnation: 0,
  epoch: 0,
  cursor: "c1",
  time: "2026-10-30T08:46:49.000Z",
  type: "message.assistant",
  payload: { text: 'Said "hi", then\nleft' },
  committed: true,
};

test("JSON keeps each event whole", () => {
  const { text, contentType } = eventExport([event], "json");
  assert.equal(contentType, "application/json");
  assert.deepEqual(JSON.parse(text), [event]);
});

test("CSV has a header and one quoted line per event", () => {
  const { text, contentType } = eventExport([event, { ...event, eventId: "e2", turnId: null, committed: false }], "csv");
  assert.equal(contentType, "text/csv");
  const lines = text.split("\r\n");
  assert.equal(lines[0], "time,type,label,summary,delivery,eventId,turnId");
  assert.match(lines[1], /^2026-10-30T08:46:49\.000Z,message\.assistant,/);
  assert.match(text, /,History,e1,turn1\r\n/);
  assert.match(text, /,Live,e2,\r\n$/);
});

test("the file is named for the session", () => {
  assert.equal(eventExportName("sess_1", "csv"), "events-sess_1.csv");
  assert.equal(eventExportName("a/b c", "json"), "events-a_b_c.json");
  assert.equal(eventExportName(undefined, "json"), "events.json");
});
