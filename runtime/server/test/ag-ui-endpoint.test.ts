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
  createVault,
  startSubjectTenant,
  type SubjectTenant,
} from "./security/subjects.js";

let tenant: SubjectTenant;
/** Reaches every agent. */
let issuer: TestIssuer;
/** Reaches only the agent `other`. */
let elsewhere: TestIssuer;

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
  const response = await fetch(`${url}/v1/ag-ui/agents/${agent}`, {
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
  tenant = await startSubjectTenant({
    issuers: createTrustedIssuers([...issuer.configs, ...elsewhere.configs]),
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

  it("attaches the person's own vaults on the first run, refuses info, and never changes the session", async () => {
    const token = await mint("app:xia");
    const { vaultId } = await createVault(tenant, {
      subject: "app:xia",
      scopes: ["sessions:own"],
    });
    const info = await run(
      tenant.runtime.url,
      "bot",
      input("x0", "m0", { forwardedProps: { nylorun: { session: { info: { plan: "pro" } } } } }),
      bearer(token)
    );
    expect(info.status).toBe(403);
    const first = await run(
      tenant.runtime.url,
      "bot",
      input("x1", "m1", { forwardedProps: { nylorun: { session: { vaultIds: [vaultId] } } } }),
      bearer(token)
    );
    expect(first.status).toBe(200);
    const id = sessionIdFor("app:xia", "bot", "x1");
    expect((await tenant.call("GET", `/v1/sessions/${id}`)).body.vaultIds).toEqual([vaultId]);
    // A later run without options keeps the vaults.
    await run(tenant.runtime.url, "bot", input("x1", "m2"), bearer(token));
    expect((await tenant.call("GET", `/v1/sessions/${id}`)).body.vaultIds).toEqual([vaultId]);
    // Another owner's vault is refused.
    const { vaultId: other } = await createVault(tenant, {
      subject: "app:yan",
      scopes: ["sessions:own"],
    });
    const foreign = await run(
      tenant.runtime.url,
      "bot",
      input("x2", "m1", { forwardedProps: { nylorun: { session: { vaultIds: [other] } } } }),
      bearer(token)
    );
    expect(foreign.status).toBe(404);
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
      await call("PUT", "/v1/agents/bot", {
        requestId: "bot",
        manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
        implementationVersion: "dev",
      });
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
