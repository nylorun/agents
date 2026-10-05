import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

/** The `nylorun.event/2` fields a fixture event needs besides its ids, type and payload. */
const envelope = (time: string) => ({
  schema: "nylorun.event/2",
  runId: null,
  incarnation: 0,
  epoch: 0,
  seq: 0,
  time,
  schemaVersion: 1,
  source: { kind: "loop", id: "runtime" },
  evidence: "observed",
  visibility: "public",
  retention: "full",
});

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";

function healthOk() {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
  });
}

describe("SessionClient.input (WF-R4 / WF-C6)", () => {
  it("sends content for string values", async () => {
    let body: unknown;
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        if (String(url).endsWith("/health")) return healthOk();
        body = JSON.parse(String(init?.body));
        return Response.json({
          status: "accepted",
          turnId: "t1",
          cursor: "c1",
          requestId: "r1",
        });
      },
    });
    await client.session("s1").input("hello", { idempotencyKey: "k1" });
    expect(body).toMatchObject({
      type: "message",
      content: "hello",
      idempotencyKey: "k1",
    });
    expect(body).not.toHaveProperty("data");
  });

  it("sends data for non-string values", async () => {
    let body: unknown;
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        if (String(url).endsWith("/health")) return healthOk();
        body = JSON.parse(String(init?.body));
        return Response.json({
          status: "accepted",
          turnId: "t1",
          cursor: "c1",
          requestId: "r1",
        });
      },
    });
    await client.session("s1").input({ task: "ship" }, { idempotencyKey: "k2" });
    expect(body).toMatchObject({
      type: "message",
      data: { task: "ship" },
      idempotencyKey: "k2",
    });
    expect(body).not.toHaveProperty("content");
  });
});

describe("SessionClient.pending (WF-C6)", () => {
  it("returns waits from inspect", async () => {
    const waits = [
      {
        invocationId: "i1",
        interaction: { kind: "approval", prompt: "Open PR?" },
        status: "pending",
      },
    ];
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url) => {
        if (String(url).endsWith("/health")) return healthOk();
        return Response.json({
          id: "s1",
          agentId: "wf",
          ownerUserId: "u1",
          status: "paused",
          activeTurnId: "t1",
          waits,
        });
      },
    });
    await expect(client.session("s1").pending()).resolves.toEqual(waits);
  });
});

describe("SessionClient.sandbox (WF-C6)", () => {
  it("POSTs built-ins to the session sandbox endpoint", async () => {
    let seen: { path: string; body: unknown } | undefined;
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/health")) return healthOk();
        seen = { path, body: JSON.parse(String(init?.body)) };
        return Response.json({ stdout: "ok", exitCode: 0 });
      },
    });
    const result = await client.session("s1").sandbox.bash({ command: "echo hi" });
    expect(seen?.path).toContain("/v1/sessions/s1/sandbox/bash");
    expect(seen?.body).toEqual({ command: "echo hi" });
    expect(result).toEqual({ stdout: "ok", exitCode: 0 });
  });
});

describe("SessionClient.observe follow (WF-EV8 / WF-C6)", () => {
  it("merges linked agent session events when follow is true", async () => {
    const sse = (events: { id: string; data: unknown }[], hold?: AbortSignal) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const e of events) {
            controller.enqueue(
              enc.encode(
                `id: ${e.id}\nevent: message\ndata: ${JSON.stringify(e.data)}\n\n`,
              ),
            );
          }
          if (!hold) {
            controller.close();
            return;
          }
          const stop = () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          hold.addEventListener("abort", stop, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/health")) return healthOk();
        if (path.includes("/v1/sessions/wf/events")) {
          return sse(
            [
              {
                id: "1",
                data: {
                  eventId: "1",
                  sessionId: "wf",
                  tenantId: TENANT,
                  turnId: "t1",
                  cursor: "1",
                  ...envelope("2026-01-01T00:00:00.000Z"),
                  type: "node.agent",
                  payload: {
                    type: "node.agent",
                    path: "polish/writer",
                    sessionId: "agent-1",
                    turnId: "at1",
                  },
                },
              },
              {
                id: "2",
                data: {
                  eventId: "2",
                  sessionId: "wf",
                  tenantId: TENANT,
                  turnId: "t1",
                  cursor: "2",
                  ...envelope("2026-01-01T00:00:02.000Z"),
                  type: "node.completed",
                  payload: { type: "node.completed", path: "polish/writer" },
                },
              },
            ],
            init?.signal ?? undefined,
          );
        }
        if (path.includes("/v1/sessions/agent-1/events")) {
          return sse([
            {
              id: "a1",
              data: {
                eventId: "a1",
                sessionId: "agent-1",
                tenantId: TENANT,
                turnId: "at1",
                cursor: "a1",
                ...envelope("2026-01-01T00:00:01.000Z"),
                type: "turn.completed",
                payload: { type: "turn.completed", output: "draft" },
              },
            },
          ]);
        }
        throw new Error(`unexpected ${path}`);
      },
    });

    const abort = new AbortController();
    const seen: string[] = [];
    for await (const event of client.session("wf").observe({
      follow: true,
      signal: abort.signal,
    })) {
      seen.push(`${event.sessionId}:${event.type}`);
      if (seen.length >= 3) {
        abort.abort();
        break;
      }
    }
    expect(seen).toContain("wf:node.agent");
    expect(seen).toContain("agent-1:turn.completed");
    expect(seen).toContain("wf:node.completed");
  });
});
