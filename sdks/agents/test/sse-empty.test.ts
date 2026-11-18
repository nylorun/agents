import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { SSE_MAX_EMPTY_CONNECTIONS, SSEStreamClosedError } from "../src/sse.js";

const KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000001";

const frame = (cursor: string) =>
  `id: ${cursor}\nevent: turn.completed\ndata: ${JSON.stringify({
    schema: "nylorun.event/2",
    runId: null,
    incarnation: 0,
    epoch: 0,
    seq: 0,
    time: "2026-11-17T00:00:00.000Z",
    schemaVersion: 1,
    source: { kind: "loop", id: "runtime" },
    evidence: "observed",
    visibility: "public",
    retention: "full",
    eventId: `e_${cursor}`,
    sessionId: "s1",
    tenantId: TENANT,
    turnId: "t1",
    cursor,
    type: "turn.completed",
    payload: {},
  })}\n\n`;

/** A `200` event stream that sends `text` and ends. */
const ending = (text: string) =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });

/** A client whose session event streams are the `connections`' bodies, one per connection. */
function clientOf(connections: readonly string[]) {
  const cursors: (string | null)[] = [];
  const client = new AgentsClient({
    url: "http://127.0.0.1:8787",
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({
          status: "ok",
          protocol: { ...HOST_PROTOCOL, features: [...HOST_PROTOCOL.features] },
        });
      cursors.push(new Headers(init?.headers).get("last-event-id"));
      return ending(connections[cursors.length - 1] ?? "");
    },
  });
  return { session: client.session("s1"), cursors };
}

async function drain(events: AsyncIterable<{ cursor: string }>): Promise<{ seen: string[]; error: unknown }> {
  const seen: string[] = [];
  try {
    for await (const event of events) seen.push(event.cursor);
  } catch (error) {
    return { seen, error };
  }
  return { seen, error: undefined };
}

describe("observe on a stream that keeps closing with nothing on it", () => {
  it("gives up after 5 connections by default", () => {
    expect(SSE_MAX_EMPTY_CONNECTIONS).toBe(5);
  });

  // On beta (17 Nov 2026) a session's stream from its start answered `200` and closed with no
  // frame, every time; `observe` reconnected from the same cursor forever, silently.
  it("throws SSEStreamClosedError instead of reconnecting from the same cursor forever", async () => {
    const { session, cursors } = clientOf([]);
    const { seen, error } = await drain(session.observe({ maxEmptyConnections: 3 }));
    expect(seen).toEqual([]);
    expect(error).toBeInstanceOf(SSEStreamClosedError);
    expect(error).toMatchObject({ connections: 3, cursor: undefined });
    expect(cursors).toEqual([null, null, null]);
  });

  it("counts again from an event, and reports the cursor it was stuck at", async () => {
    const { session, cursors } = clientOf(["", frame("c1"), "", ""]);
    const { seen, error } = await drain(session.observe({ maxEmptyConnections: 2 }));
    expect(seen).toEqual(["c1"]);
    expect(error).toMatchObject({ name: "SSEStreamClosedError", connections: 2, cursor: "c1" });
    expect(cursors).toEqual([null, null, "c1", "c1"]);
  });

  it("does not count a connection that sent a keepalive (a quiet session behind a proxy)", async () => {
    const quiet = ": keepalive\n\n";
    const { session, cursors } = clientOf([quiet, quiet, quiet, frame("c1")]);
    const abort = new AbortController();
    const seen: string[] = [];
    for await (const event of session.observe({ signal: abort.signal, maxEmptyConnections: 1 })) {
      seen.push(event.cursor);
      abort.abort();
    }
    expect(seen).toEqual(["c1"]);
    expect(cursors).toHaveLength(4);
  });
});
