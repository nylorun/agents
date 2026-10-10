/**
 * `createAgUiHandler` as a pass-through: it signs the person in, keeps to its agent list,
 * replaces the session options the browser may send with the host's, and forwards to the
 * Runtime's AG-UI endpoint acting for the person. The protocol itself is the Runtime's
 * (`runtime/server/test/ag-ui.test.ts`, `runtime/server/test/ag-ui/translate.test.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
} from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { createAgUiHandler } from "../src/ag-ui/index.js";

const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function health(features: readonly string[] = HOST_PROTOCOL.features) {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    protocol: { ...HOST_PROTOCOL, features: [...features] },
  });
}

interface Sent {
  method: string;
  path: string;
  search: string;
  subject: string | null;
  scopes: string | null;
  lastEventId: string | null;
  authorization: string | null;
  body?: any;
}

/** A client whose Runtime answers `/health` and records every other request. */
function fakeClient(
  options: {
    features?: readonly string[];
    respond?: (url: URL, init?: RequestInit) => Response | undefined;
  } = {}
) {
  const sent: Sent[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return health(options.features);
      const headers = new Headers(init?.headers);
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        subject: headers.get("nylorun-subject"),
        scopes: headers.get("nylorun-scopes"),
        lastEventId: headers.get("last-event-id"),
        authorization: headers.get("authorization"),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return (
        options.respond?.(url, init) ??
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream", "x-runtime-secret": "no" },
        })
      );
    },
  });
  return { client, sent };
}

const runBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "m1", role: "user", content: "hi" }],
    tools: [],
    context: [],
    ...extra,
  });

describe("createAgUiHandler routing", () => {
  const { client, sent } = fakeClient();
  const handler = createAgUiHandler({
    basePath: "/api/agui/",
    agents: ["bot", { id: "helper" } as never],
    client,
    subject: (request) => request.headers.get("x-user") ?? undefined,
  });
  const call = (path: string, init: RequestInit = {}) =>
    handler.fetch(
      new Request(`http://app.test${path}`, {
        ...init,
        headers: { "x-user": "ada", ...(init.headers as object) },
      })
    );

  it("answers 404 for paths outside basePath, unknown shapes and agents outside the list", async () => {
    for (const path of [
      "/other/bot",
      "/api/aguix/bot",
      "/api/agui",
      "/api/agui/bot/extra",
      "/api/agui/bot/threads/t1/unknown",
      "/api/agui/bot/threads//messages",
      "/api/agui/%E0%A4%A",
    ])
      expect((await call(path, { method: "POST" })).status, path).toBe(404);
    expect(
      (await call("/api/agui/secret", { method: "POST", body: runBody() })).status
    ).toBe(404);
    expect((await call("/api/agui/secret/threads/t1/messages")).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("answers 405 with Allow for a known path and the wrong method", async () => {
    const run = await call("/api/agui/bot");
    expect(run.status).toBe(405);
    expect(run.headers.get("allow")).toBe("POST");
    const history = await call("/api/agui/helper/threads/t1/messages", {
      method: "POST",
    });
    expect(history.headers.get("allow")).toBe("GET");
    const cancel = await call("/api/agui/bot/threads/t1/cancel");
    expect(cancel.headers.get("allow")).toBe("POST");
  });

  it("answers 401 without a subject and 400 for a body that is not JSON", async () => {
    const anonymous = await handler.fetch(
      new Request("http://app.test/api/agui/bot", { method: "POST", body: runBody() })
    );
    expect(anonymous.status).toBe(401);
    expect((await call("/api/agui/bot", { method: "POST", body: "{" })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("forwards each route to the Runtime's AG-UI endpoint, acting for the person", async () => {
    sent.splice(0);
    const run = await call("/api/agui/bot", { method: "POST", body: runBody() });
    expect(run.status).toBe(200);
    expect(run.headers.get("content-type")).toBe("text/event-stream");
    expect(run.headers.get("x-runtime-secret")).toBeNull();
    expect(await run.text()).toBe("data: {}\n\n");
    await call("/api/agui/helper/threads/t1/messages");
    await call("/api/agui/bot/threads/t1/events?runId=r1", {
      headers: { "last-event-id": "c9" },
    });
    await call("/api/agui/bot/threads/t1/cancel", { method: "POST" });
    expect(sent.map((s) => `${s.method} ${s.path}${s.search}`)).toEqual([
      "POST /v1/ag-ui/agents/bot",
      "GET /v1/ag-ui/agents/helper/threads/t1/messages",
      "GET /v1/ag-ui/agents/bot/threads/t1/events?runId=r1",
      "POST /v1/ag-ui/agents/bot/threads/t1/cancel",
    ]);
    for (const request of sent) {
      expect(request.subject).toBe("ada");
      expect(request.scopes).toBe("sessions:own");
      expect(request.authorization).toBe(`Bearer ${KEY}`);
    }
    expect(sent[2]!.lastEventId).toBe("c9");
    expect(sent[0]!.body).toMatchObject({ threadId: "t1", runId: "r1" });
  });
});

describe("createAgUiHandler acting for subjects", () => {
  it("sends the host's session options and never the browser's", async () => {
    const { client, sent } = fakeClient();
    const handler = createAgUiHandler({
      agents: ["bot"],
      client,
      scopes: ["sessions:own", "agents:read"],
      subject: () => "ada",
      session: () => ({ vaultIds: ["v1"], info: { plan: "pro" } }),
    });
    await handler.fetch(
      new Request("http://app.test/bot", {
        method: "POST",
        body: runBody({
          forwardedProps: { theme: "dark", nylorun: { session: { info: { plan: "free" } } } },
        }),
      })
    );
    expect(sent[0]!.scopes).toBe("sessions:own agents:read");
    expect(sent[0]!.body.forwardedProps).toEqual({
      theme: "dark",
      nylorun: { session: { vaultIds: ["v1"], info: { plan: "pro" } } },
    });
  });

  it("drops the browser's session options when the host has none", async () => {
    const { client, sent } = fakeClient();
    const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "ada" });
    await handler.fetch(
      new Request("http://app.test/bot", {
        method: "POST",
        body: runBody({ forwardedProps: { nylorun: { session: { info: { admin: true } } } } }),
      })
    );
    expect(sent[0]!.body.forwardedProps).toEqual({});
  });

  it("maps the Runtime's refusals and never passes its details on", async () => {
    for (const [status, expected] of [
      [400, { status: 400, code: "invalid_request" }],
      [404, { status: 404 }],
      [409, { status: 409, code: "session_busy" }],
      [500, { status: 502, code: "runtime_error" }],
    ] as const) {
      const { client } = fakeClient({
        respond: () =>
          Response.json(
            { status: "rejected", code: "x", message: "internal detail" },
            { status }
          ),
      });
      const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "ada" });
      const response = await handler.fetch(new Request("http://app.test/bot/threads/t1/messages"));
      expect(response.status).toBe(expected.status);
      const body = await response.json();
      if ("code" in expected) expect(body.code).toBe(expected.code);
      expect(JSON.stringify(body)).not.toContain("internal detail");
    }
  });

  it("refuses unknown scopes when it is created", () => {
    const { client } = fakeClient();
    expect(() =>
      createAgUiHandler({
        agents: ["bot"],
        client,
        scopes: ["sessions:all" as never],
        subject: () => "ada",
      })
    ).toThrow(/Unknown scope/);
  });

  it("answers 500 when the host names a subject the Runtime cannot", async () => {
    const { client, sent } = fakeClient();
    const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "host" });
    const response = await handler.fetch(new Request("http://app.test/bot/threads/t1/messages"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "subject_invalid" });
    expect(sent).toEqual([]);
  });
});

describe("createAgUiHandler against an older Runtime", () => {
  it("answers 502 naming ag-ui-endpoint and calls nothing else", async () => {
    for (const features of [
      PROTOCOL_FEATURES,
      HOST_PROTOCOL.features.filter((f) => f !== "ag-ui-endpoint"),
    ]) {
      const { client, sent } = fakeClient({ features });
      const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "ada" });
      const response = await handler.fetch(
        new Request("http://app.test/bot", { method: "POST", body: runBody() })
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.code).toBe("runtime_feature_missing");
      expect(body.error).toContain("ag-ui-endpoint");
      expect(sent).toEqual([]);
    }
  });
});
