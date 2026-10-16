/**
 * The Runtime's AG-UI endpoint called directly (Host feature `ag-ui-endpoint`): with a trusted
 * issuer's token, with subject headers, and the thread's session shared between the two. The
 * protocol mapping itself is covered through the SDK handler in `ag-ui.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "../src/api/ag-ui/session-id.js";
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { testIssuer, type TestIssuer } from "./support/issuer.js";
import { startTestTenant } from "./support/tenant.js";
import {
  APP,
  createEnvironment,
  startSubjectTenant,
  type SubjectTenant,
} from "./security/subjects.js";

let tenant: SubjectTenant;
/** Reaches every agent. */
let issuer: TestIssuer;
/** Reaches only the agent `other`. */
let elsewhere: TestIssuer;
/** Reaches the Agents `people/{person}` and `shared/*`. */
let granted: TestIssuer;

const mint = (subject: string, ttlSeconds?: number) =>
  issuer.sign(subject, "sessions:own", ttlSeconds ? { ttlSeconds } : {});

const input = (threadId: string, messageId: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  runId: `run-${messageId}`,
  messages: [{ id: messageId, role: "user", content: "hi" }],
  tools: [],
  context: [],
  ...extra,
});

/** Posts a run and returns the AG-UI events it streamed. */
async function run(
  url: string,
  agent: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; events: any[]; text: string }> {
  const response = await fetch(`${url}/v1/ag-ui/agents/${encodeURIComponent(agent)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, events, text };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const asSubject = (subject: string) => ({
  authorization: `Bearer ${APP}`,
  "nylorun-subject": subject,
  "nylorun-scopes": "sessions:own",
});

beforeAll(async () => {
  issuer = await testIssuer();
  elsewhere = await testIssuer({ name: "elsewhere", iss: "https://elsewhere.test", agents: ["other"] });
  granted = await testIssuer({
    name: "granted",
    iss: "https://granted.test",
    agents: ["people/{person}", "shared/*"],
  });
  tenant = await startSubjectTenant({
    issuers: createTrustedIssuers([...issuer.configs, ...elsewhere.configs, ...granted.configs]),
  });
});
afterAll(async () => {
  await tenant.close();
});
afterEach(() => vi.useRealTimers());

describe("with a trusted issuer's token", () => {
  it("runs a chat and rebuilds the thread's messages", async () => {
    const token = await mint("app:uma");
    const result = await run(tenant.runtime.url, "bot", input("u1", "m1"), bearer(token));
    expect(result.status).toBe(200);
    const types = result.events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    const history = await fetch(
      `${tenant.runtime.url}/v1/ag-ui/agents/bot/threads/u1/messages`,
      { headers: bearer(token) }
    );
    const messages = await history.json();
    expect(messages[0]).toMatchObject({ id: "m1", role: "user", content: "hi" });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "ok" });
    // The thread's session is the one every path names.
    const session = await tenant.call("GET", `/v1/sessions/${sessionIdFor("app:uma", "bot", "u1")}`);
    expect(session.body).toMatchObject({ agentId: "bot", ownerUserId: "app:uma" });
  });

  it("answers an empty history for a thread that never ran and another person's thread", async () => {
    const token = await mint("app:vic");
    const response = await fetch(
      `${tenant.runtime.url}/v1/ag-ui/agents/bot/threads/u1/messages`,
      { headers: bearer(token) }
    );
    expect(await response.json()).toEqual([]);
  });

  it("is limited to the issuer's agents", async () => {
    const token = await elsewhere.sign("app:wes", "sessions:own");
    const result = await run(tenant.runtime.url, "bot", input("w1", "m1"), bearer(token));
    expect(result.status).toBe(404);
  });

  it("runs on the Agents its grants name, refuses info and the removed session options", async () => {
    const token = await granted.sign("app:xia", "sessions:own", { claims: { person: "xia" } });
    const xia = { subject: "app:xia", scopes: ["sessions:own"] } as const;
    const { environmentId: agentId } = await createEnvironment(tenant, xia, { id: "people/xia" });
    const info = await run(
      tenant.runtime.url,
      agentId,
      input("x0", "m0", { forwardedProps: { nylorun: { session: { info: { plan: "pro" } } } } }),
      bearer(token)
    );
    expect(info.status).toBe(403);
    // The removed session options are refused, not ignored: vaults (protocol 11), and an
    // Environment (protocol 16: the URL names the Agent the session runs on).
    for (const session of [{ vaultIds: ["vlt_x"] }, { environment: agentId }]) {
      const removed = await run(
        tenant.runtime.url,
        agentId,
        input("x0", "m0", { forwardedProps: { nylorun: { session } } }),
        bearer(token)
      );
      expect(removed.status, JSON.stringify(session)).toBe(400);
    }
    const first = await run(tenant.runtime.url, agentId, input("x1", "m1"), bearer(token));
    expect(first.status).toBe(200);
    const id = sessionIdFor("app:xia", agentId, "x1");
    expect((await tenant.call("GET", `/v1/sessions/${id}`)).body).toMatchObject({
      agentId,
      ownerUserId: "app:xia",
    });
    // A later run continues the same session.
    expect((await run(tenant.runtime.url, agentId, input("x1", "m2"), bearer(token))).status).toBe(200);
    // The Agent `bot` is not among its grants.
    expect((await run(tenant.runtime.url, "bot", input("x1", "m3"), bearer(token))).status).toBe(404);
    // An Agent the token's grants miss is refused.
    const { environmentId: ungranted } = await createEnvironment(
      tenant,
      { subject: "app:yan", scopes: ["sessions:own"] },
      { id: "people/yan" }
    );
    const missed = await run(tenant.runtime.url, ungranted, input("x2", "m1"), bearer(token));
    expect(missed.status).toBe(404);
    // So is one the grants reach but guarded for another owner: the 404 of one that does not exist.
    const { environmentId: foreign } = await createEnvironment(
      tenant,
      { subject: "app:yan", scopes: ["sessions:own"] },
      { id: "shared/yan" }
    );
    const guarded = await run(tenant.runtime.url, foreign, input("x3", "m1"), bearer(token));
    expect(guarded.status).toBe(404);
    const nobody = await run(tenant.runtime.url, "shared/nobody", input("x3", "m1"), bearer(token));
    expect(nobody.status).toBe(404);
    expect(guarded.text).toBe(nobody.text);
  });
});

describe("with an application key", () => {
  it("needs a subject", async () => {
    const result = await run(tenant.runtime.url, "bot", input("a1", "m1"), {
      authorization: `Bearer ${APP}`,
    });
    expect(result.status).toBe(400);
  });

  it("continues a thread an app server started, directly with a token for the same person", async () => {
    const byServer = await run(tenant.runtime.url, "bot", input("p1", "m1"), asSubject("app:pia"));
    expect(byServer.status).toBe(200);
    const token = await mint("app:pia");
    const direct = await run(tenant.runtime.url, "bot", input("p1", "m2"), bearer(token));
    expect(direct.status).toBe(200);
    const messages = await (
      await fetch(`${tenant.runtime.url}/v1/ag-ui/agents/bot/threads/p1/messages`, {
        headers: bearer(token),
      })
    ).json();
    expect(messages.filter((m: any) => m.role === "user").map((m: any) => m.id)).toEqual(["m1", "m2"]);
  });

  it("lets an app server set session info", async () => {
    const result = await run(
      tenant.runtime.url,
      "bot",
      input("i1", "m1", { forwardedProps: { nylorun: { session: { info: { plan: "pro" } } } } }),
      asSubject("app:ivo")
    );
    expect(result.status).toBe(200);
  });
});

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const withParts = (threadId: string, messageId: string, content: unknown[]) => ({
  ...input(threadId, messageId),
  messages: [{ id: messageId, role: "user", content }],
});

/** The artifacts of a thread's session, as the application sees them. */
async function artifactsOf(subject: string, threadId: string) {
  const id = sessionIdFor(subject, "bot", threadId);
  return (await tenant.call("GET", `/v1/artifacts?sessionId=${encodeURIComponent(id)}`)).body
    .artifacts as { artifactId: string; name: string; contentType: string }[];
}

describe("files in a message", () => {
  it("stores inline bytes as an artifact of the thread's session and gives them back as a file source", async () => {
    const token = await mint("app:fay");
    const image = { type: "image", source: { type: "data", value: PNG, mimeType: "image/png" }, metadata: { filename: "room.png" } };
    const first = await run(
      tenant.runtime.url,
      "bot",
      withParts("f1", "m1", [{ type: "text", text: "What is this?" }, image]),
      bearer(token)
    );
    expect(first.status, first.text).toBe(200);
    expect(first.events.at(-1).type).toBe("RUN_FINISHED");
    const [stored, ...others] = await artifactsOf("app:fay", "f1");
    expect(others).toEqual([]);
    expect(stored).toMatchObject({ name: "room.png", contentType: "image/png" });
    // The next message names the stored artifact; a file the client did not name gets one.
    const pdf = Buffer.from("%PDF-1.4 brief").toString("base64");
    const second = await run(
      tenant.runtime.url,
      "bot",
      withParts("f1", "m2", [
        { type: "image", source: { type: "file", value: stored!.artifactId, provider: "nylorun" } },
        { type: "document", source: { type: "data", value: pdf, mimeType: "application/pdf" } },
      ]),
      bearer(token)
    );
    expect(second.status, second.text).toBe(200);
    expect((await artifactsOf("app:fay", "f1")).map((a) => a.name)).toEqual(["room.png", "file-2.pdf"]);
    const messages = await (
      await fetch(`${tenant.runtime.url}/v1/ag-ui/agents/bot/threads/f1/messages`, { headers: bearer(token) })
    ).json();
    const source = { type: "file", value: stored!.artifactId, provider: "nylorun", mimeType: "image/png" };
    expect(messages.filter((m: any) => m.role === "user")).toEqual([
      { id: "m1", role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", source }] },
      {
        id: "m2",
        role: "user",
        content: [
          { type: "image", source },
          {
            type: "document",
            source: { type: "file", value: expect.any(String), provider: "nylorun", mimeType: "application/pdf" },
          },
        ],
      },
    ]);
  });

  it("replays a retried message with the files it stored the first time", async () => {
    const body = withParts("f2", "m1", [
      { type: "text", text: "Read this" },
      { type: "image", source: { type: "data", value: PNG, mimeType: "image/png" } },
    ]);
    const first = await run(tenant.runtime.url, "bot", body, asSubject("app:gus"));
    const again = await run(tenant.runtime.url, "bot", body, asSubject("app:gus"));
    expect(again.status, again.text).toBe(200);
    expect(again.events.map((e) => e.type)).toEqual(first.events.map((e) => e.type));
    expect(await artifactsOf("app:gus", "f2")).toHaveLength(1);
  });

  it("takes a body past 1 MiB", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
    const result = await run(
      tenant.runtime.url,
      "bot",
      withParts("f3", "m1", [{ type: "document", source: { type: "data", value: big, mimeType: "text/plain" } }]),
      asSubject("app:hal")
    );
    expect(result.status, result.text).toBe(200);
    expect(await artifactsOf("app:hal", "f3")).toMatchObject([{ name: "file-1.txt", contentType: "text/plain" }]);
  });

  it.each([
    ["a URL", { type: "image", source: { type: "url", value: "https://example.test/a.png" } }, /not fetched/],
    ["bad base64", { type: "image", source: { type: "data", value: "%%%", mimeType: "image/png" } }, /base64/],
    ["another provider's handle", { type: "document", source: { type: "file", value: "file-abc", provider: "openai" } }, /provider "nylorun"/],
  ])("refuses %s", async (_name, part, message) => {
    const result = await run(tenant.runtime.url, "bot", withParts("f4", "m1", [part]), asSubject("app:ida"));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).message ?? result.text).toMatch(message);
  });

  it("deletes the files it stored when the message is refused", async () => {
    const result = await run(
      tenant.runtime.url,
      "bot",
      withParts("f5", "m1", [
        { type: "image", source: { type: "data", value: PNG, mimeType: "image/png" } },
        { type: "image", source: { type: "file", value: "af_00000000000000000000000000", provider: "nylorun" } },
      ]),
      asSubject("app:jon")
    );
    expect(result.status).toBe(404);
    expect(await artifactsOf("app:jon", "f5")).toEqual([]);
  });
});

describe("a token that expires during a run", () => {
  it("ends the stream with nylorun.stream_closed and no RUN_FINISHED", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = await startTestTenant({
      issuers: createTrustedIssuers(issuer.configs),
      applicationKey: APP,
      vaultKek: Buffer.alloc(32, 3).toString("base64"),
      modelProvider: async () => {
        await gate;
        return { output: [{ type: "text", text: "late" }] };
      },
    });
    try {
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${slow.url}${path}`, {
          method,
          headers: { ...slow.headers(APP), "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const { Agent } = await import("@nylorun/core/define");
      const { manifestOf } = await import("./support/agents.js");
      expect((await call("PUT", "/v1/agent-manifests/bot", manifestOf(Agent({ id: "bot", name: "Bot" }).build()))).status).toBe(200);
      expect((await call("PUT", "/v1/agents/bot", { requestId: "bot", manifest: "bot" })).status).toBe(200);
      const token = await mint("app:sam", 60);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 59_500);
      const response = await fetch(`${slow.url}/v1/ag-ui/agents/bot`, {
        method: "POST",
        headers: {
          ...slow.headers(token),
          "content-type": "application/json",
        },
        body: JSON.stringify(input("s1", "m1")),
      });
      const text = await response.text();
      expect(text).toContain("nylorun.stream_closed");
      expect(text).not.toContain("RUN_FINISHED");
      vi.useRealTimers();
      release();
    } finally {
      release();
      await slow.close();
    }
  });
});
