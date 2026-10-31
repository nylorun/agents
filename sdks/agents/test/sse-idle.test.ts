import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { readSSE, SSE_IDLE_TIMEOUT_MS, SSEIdleTimeoutError } from "../src/sse.js";

const KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000001";

const frame = (cursor: string) =>
  `id: ${cursor}\nevent: turn.completed\ndata: ${JSON.stringify({
    schema: "nylorun.event/2",
    runId: null,
    incarnation: 0,
    epoch: 0,
    seq: 0,
    time: "2026-10-31T00:00:00.000Z",
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream that sends `script`'s chunks after their delays, then stays open and silent. */
function stream(script: readonly { after: number; text: string }[]) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of script) {
        await sleep(step.after);
        if (cancelled) return;
        controller.enqueue(encoder.encode(step.text));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    cancelled: () => cancelled,
  };
}

describe("SSE idle timeout", () => {
  it("defaults to 45 seconds", () => {
    expect(SSE_IDLE_TIMEOUT_MS).toBe(45_000);
  });

  it("counts keepalive comments as liveness", async () => {
    const { response } = stream([
      { after: 0, text: frame("c1") },
      ...Array.from({ length: 6 }, () => ({ after: 40, text: ": keepalive\n\n" })),
      { after: 40, text: frame("c2") },
    ]);
    const ids: (string | undefined)[] = [];
    const abort = new AbortController();
    for await (const event of readSSE(response, abort.signal, { idleTimeoutMs: 100 })) {
      ids.push(event.id);
      if (ids.length === 2) abort.abort();
    }
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("stops a silent stream with SSEIdleTimeoutError", async () => {
    const { response, cancelled } = stream([{ after: 0, text: frame("c1") }]);
    const ids: (string | undefined)[] = [];
    const started = Date.now();
    const error = await (async () => {
      for await (const event of readSSE(response, new AbortController().signal, {
        idleTimeoutMs: 80,
      }))
        ids.push(event.id);
    })().catch((caught) => caught);
    expect(error).toBeInstanceOf(SSEIdleTimeoutError);
    expect(ids).toEqual(["c1"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(cancelled()).toBe(true);
  });

  it("does not count the time the consumer holds an event", async () => {
    const { response } = stream([
      { after: 0, text: frame("c1") },
      { after: 0, text: frame("c2") },
    ]);
    const ids: (string | undefined)[] = [];
    const abort = new AbortController();
    for await (const event of readSSE(response, abort.signal, { idleTimeoutMs: 60 })) {
      ids.push(event.id);
      if (ids.length === 2) break;
      await sleep(150);
    }
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("reconnects session.observe from Last-Event-ID after silence", async () => {
    const connections: (string | null)[] = [];
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
        connections.push(new Headers(init?.headers).get("last-event-id"));
        // The first connection sends one event, a keepalive, then goes silent; the next resumes.
        return connections.length === 1
          ? stream([
              { after: 0, text: frame("c1") },
              { after: 30, text: ": keepalive\n\n" },
            ]).response
          : stream([{ after: 0, text: frame("c2") }]).response;
      },
    });
    const abort = new AbortController();
    const cursors: string[] = [];
    for await (const event of client
      .session("s1")
      .observe({ signal: abort.signal, idleTimeoutMs: 80 })) {
      cursors.push(event.cursor);
      if (cursors.length === 2) abort.abort();
    }
    expect(cursors).toEqual(["c1", "c2"]);
    expect(connections).toEqual([null, "c1"]);
  });

  it("waits forever with idleTimeoutMs 0", async () => {
    const { response } = stream([
      { after: 0, text: frame("c1") },
      { after: 120, text: frame("c2") },
    ]);
    const ids: (string | undefined)[] = [];
    const abort = new AbortController();
    for await (const event of readSSE(response, abort.signal, { idleTimeoutMs: 0 })) {
      ids.push(event.id);
      if (ids.length === 2) abort.abort();
    }
    expect(ids).toEqual(["c1", "c2"]);
  });
});
