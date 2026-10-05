/**
 * Characterization of the Runtime's server-sent event streams on the wire: the exact response
 * headers and frame bytes of session events (including the `nylorun.closed` end frame) and
 * the AG-UI run stream. Read through `node:http` so nothing
 * between the Runtime and the assertion normalizes headers or frames.
 */
import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";
import { testIssuer, type TestIssuer } from "../support/issuer.js";
import { testPool } from "../support/store.js";

const TENANT = `tn_${"0".repeat(22)}sse0`;
const APPLICATION_KEY = "sse-bytes-application-key-0000000";
const SUBJECT = "app:ann";

let root: string;
let rt: EphemeralRuntime;
let issuer: TestIssuer;

const app = {
  "nylorun-protocol": "4",
  "nylorun-tenant": TENANT,
  authorization: `Bearer ${APPLICATION_KEY}`,
};

async function call(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${rt.url}${path}`, {
    method,
    headers: { ...app, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBe(200);
  return parsed;
}

/** A user message to `session`, so its stream has an event to send. */
function say(session: string, content: string): Promise<Record<string, unknown>> {
  return call("POST", `/v1/sessions/${session}/commands`, {
    type: "message",
    requestId: content,
    idempotencyKey: content,
    content,
  });
}

interface Stream {
  status: number;
  /**
   * Response headers as sent, lowercased, without `date` and without `keep-alive`, whose
   * timeout is Node's server default rather than the Runtime's.
   */
  headers: Record<string, string>;
  /** Resolves with everything received once `done` holds for it, or the stream ends. */
  until(done: (text: string) => boolean): Promise<string>;
  close(): void;
}

function open(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${rt.url}${path}`,
      {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      },
      (res: IncomingMessage) => {
        let text = "";
        let ended = false;
        const waiters: (() => void)[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          for (const wake of waiters.splice(0)) wake();
        });
        res.on("end", () => {
          ended = true;
          for (const wake of waiters.splice(0)) wake();
        });
        const sent: Record<string, string> = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i]!.toLowerCase();
          if (name !== "date" && name !== "keep-alive") sent[name] = res.rawHeaders[i + 1]!;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: sent,
          async until(done) {
            while (!done(text) && !ended)
              await new Promise<void>((wake) => waiters.push(wake));
            return text;
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-sse-bytes-"));
  issuer = await testIssuer();
  rt = await startEphemeralRuntime({
    issuers: issuer.configs,
    database: testPool(),
    hostRoot: root,
    tenantId: TENANT,
    applicationKey: APPLICATION_KEY,
    model: { kind: "fixture" },
  });
  await call("PUT", "/v1/agents/bot", {
    requestId: "bot",
    manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
    implementationVersion: "dev",
  });
  await call("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: SUBJECT });
  await call("PUT", "/v1/sessions/s2", { requestId: "s2", agentId: "bot", ownerUserId: SUBJECT });
});

afterAll(async () => {
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("session events", () => {
  it("opens with these headers and frames each event as id, event and data", async () => {
    const stream = await open("GET", "/v1/sessions/s1/events", app);
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers).toEqual({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "transfer-encoding": "chunked",
      });
      await say("s1", "hello");
      const text = await stream.until((received) => received.includes("\n\n"));
      const frame = text.slice(0, text.indexOf("\n\n") + 2);
      expect(frame).toMatch(/^id: [^\n]+\nevent: [a-z_.]+\ndata: \{[^\n]*\}\n\n$/);
    } finally {
      stream.close();
    }
  });

  it("ends an issuer token's stream with the nylorun.closed frame when the token expires", async () => {
    const token = await issuer.sign(SUBJECT, "sessions:own", { ttlSeconds: 2 });
    const stream = await open("GET", "/v1/sessions/s2/events", {
      "nylorun-protocol": "4",
      "nylorun-tenant": TENANT,
      authorization: `Bearer ${String(token)}`,
    });
    try {
      expect(stream.status).toBe(200);
      await say("s2", "before expiry");
      await stream.until((text) => text.includes("\n\n"));
      const text = await stream.until((received) => received.includes("nylorun.closed"));
      expect(text.endsWith('event: nylorun.closed\ndata: {"reason":"token_expired"}\n\n')).toBe(true);
    } finally {
      stream.close();
    }
  });
});

describe("AG-UI run stream", () => {
  it("opens with these headers and sends data-only frames from RUN_STARTED to the run's end", async () => {
    const stream = await open(
      "POST",
      "/v1/ag-ui/agents/bot",
      { ...app, "nylorun-subject": "app:bea", "nylorun-scopes": "sessions:own" },
      {
        threadId: "t1",
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    );
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers).toEqual({
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
      });
      const text = await stream.until(
        (received) => received.includes('"RUN_FINISHED"') || received.includes('"RUN_ERROR"'),
      );
      const frames = text.split("\n\n").filter(Boolean);
      expect(frames[0]).toMatch(/^data: \{"type":"RUN_STARTED"/);
      for (const frame of frames) expect(frame).toMatch(/^(id: [^\n]+\n)?data: \{[^\n]*\}$/);
    } finally {
      stream.close();
    }
  });
});
