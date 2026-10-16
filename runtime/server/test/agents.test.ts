/**
 * Agents (protocol 16; Environments from protocol 11, D55, D56): an Agent is made from a saved
 * agent manifest, has its own id and vault and outlives the sessions on it; sessions on one share
 * its workspace and run their turns at once (protocol 14, D66); it moves between versions of its
 * manifest (track T3), and its manifest's name is fixed (`409 agent_fixed_field`);
 * the owner guard admits only its owner's sessions, at open and at every turn start; a token
 * caller reaches only the Agents its issuer grants, at every turn start; `agents:write` guards
 * changes; the Tenant limits how many there are; and `lifecycle.deleteAfter` deletes an unused
 * one with its vault.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { sweepUnusedAgents } from "../src/tenant/agents.js";
import type { TenantContext } from "../src/tenant/context.js";
import { VaultService } from "../src/vault/service.js";
import { manifestOf, saveManifest, writeManifest } from "./support/agents.js";
import { testIssuer, type TestIssuer } from "./support/issuer.js";
import { openTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "environments-app-key-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

/** What each kind of person may do: a trusted issuer's scopes. */
const ROLES = {
  member: "sessions:own",
  builder: "sessions:own agents:write",
} as const;
/** The issuer's grant templates: each claim set renders one grant (absent claims render none). */
const GRANTS = ["{a1}/{a2}/*", "{b1}/*", "{c1}/{c2}/{c3}"];
let issuer: TestIssuer;

interface Reply {
  status: number;
  body: any;
}

/** Turns of sessions named here wait until released. */
const held = new Map<string, () => void>();
const holds = new Map<string, Promise<void>>();
function hold(sessionId: string) {
  holds.set(sessionId, new Promise<void>((resolve) => held.set(sessionId, resolve)));
}
function release(sessionId: string) {
  held.get(sessionId)?.();
  holds.delete(sessionId);
}
const model: ModelProvider = async (effect) => {
  await holds.get(effect.sessionId);
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
const bot = Agent({ id: "bot", name: "Bot" }).instructions("Work in the sandbox.").build();
const appHeaders = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

async function call(
  method: string,
  path: string,
  body?: unknown,
  key: string = APP,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: response.status, body: parsed };
}

const path = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;

/** Saves agent manifest `name`: bot's loop with `runtime` (none: kind none). */
function save(name: string, section?: RuntimeSection): Promise<number> {
  return saveManifest(runtime.url, appHeaders, manifestOf(bot, { name, ...(section ? { runtime: section } : {}) }));
}

/** `PUT /v1/agents/{id}` from manifest `manifest` (default `ws`, kind virtual). */
function make(
  id: string,
  options: { manifest?: string; labels?: Record<string, string>; owner?: string | null } = {},
  key: string = APP,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const { manifest = "ws", ...rest } = options;
  return call("PUT", path(id), { manifest, ...rest }, key, headers);
}

/** An application key acting for `subject` (`Nylorun-Subject`) with `scopes`. */
const actingFor = (subject: string, scopes = "sessions:own") => ({
  "nylorun-subject": subject,
  "nylorun-scopes": scopes,
});

/**
 * An issuer token for `subject` with one grant: `p/q/*` (two segments and `*`), `p/*`, or the
 * exact `p/q/r`, rendered from the claims of the matching template.
 */
async function mint(subject: string, role: keyof typeof ROLES, grant?: string): Promise<string> {
  const parts = grant?.split("/") ?? [];
  const claims: Record<string, string> =
    grant === undefined
      ? {}
      : parts.at(-1) === "*" && parts.length === 3
        ? { a1: parts[0]!, a2: parts[1]! }
        : parts.at(-1) === "*" && parts.length === 2
          ? { b1: parts[0]! }
          : { c1: parts[0]!, c2: parts[1]!, c3: parts[2]! };
  return issuer.sign(subject, ROLES[role], { claims });
}

async function open(
  id: string,
  agent: string,
  options: { owner?: string; key?: string; headers?: Record<string, string>; extra?: object } = {},
): Promise<Reply> {
  return call(
    "PUT",
    `/v1/sessions/${id}`,
    {
      requestId: `open-${id}`,
      agent,
      ownerUserId: options.owner ?? "app:ada",
      ...options.extra,
    },
    options.key,
    options.headers,
  );
}

let messages = 0;
function message(sessionId: string, key: string = APP): Promise<Reply> {
  messages += 1;
  return call(
    "POST",
    `/v1/sessions/${sessionId}/commands`,
    { type: "message", requestId: `m${messages}`, idempotencyKey: `m${messages}`, content: "go" },
    key,
  );
}

async function settled(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 1600; attempt += 1) {
    const view = await call("GET", `/v1/sessions/${sessionId}`);
    if (["completed", "failed", "cancelled"].includes(view.body.status)) return view.body.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} did not settle`);
}

function tool(sessionId: string, name: string, input: Record<string, unknown>) {
  return call("POST", `/v1/sessions/${sessionId}/sandbox/${name}`, input);
}

beforeAll(async () => {
  issuer = await testIssuer({ agents: GRANTS });
  runtime = await startTestTenant({
    issuers: createTrustedIssuers(issuer.configs),
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    sandbox: { backend: "virtual" },
  });
  // Agent `bot`, of kind none; manifest `ws` makes virtual ones.
  await save("bot");
  expect((await make("bot", { manifest: "bot" })).status).toBe(200);
  await save("ws", { kind: "virtual" });
});

afterAll(async () => {
  await runtime?.close();
});

describe("the resource", { timeout: 60_000 }, () => {
  it("creates a virtual Agent once, by an id with slashes, and finds it again", async () => {
    await save("github", { kind: "virtual", network: { allowedHosts: ["api.github.com"] } });
    const created = await make("team-a/proj-42", { manifest: "github", labels: { project: "acme" } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      id: "team-a/proj-42",
      manifest: "github",
      resolvedVersion: 1,
      tracking: "tracking",
      kind: "virtual",
      harness: "nylorun",
      labels: { project: "acme" },
      state: "sleeping",
      attention: [],
      desired: "on",
      compute: { state: "ready" },
      sessions: [],
      slots: [],
      owner: null,
      forkedFrom: null,
      runtime: { network: { allowedHosts: ["api.github.com"] }, harness: "nylorun", lifecycle: {} },
    });
    expect(created.body.runtime.image).toBeUndefined();
    expect(created.body.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    for (const gone of ["version", "appliedVersion", "manifestName", "manifestVersion", "ownerUserId", "pod"])
      expect(created.body).not.toHaveProperty(gone);
    expect(created.body.compute.pod).toBeUndefined();
    // Idempotent: the same call, or one without labels, finds it unchanged.
    const again = await make("team-a/proj-42", { manifest: "github" });
    expect(again.body).toMatchObject({
      id: "team-a/proj-42",
      createdAt: created.body.createdAt,
      resolvedVersion: 1,
      labels: { project: "acme" },
    });
    expect((await make("team-a/proj-42", { manifest: "github@1" })).body).toMatchObject({ resolvedVersion: 1 });
    expect((await call("GET", path("team-a/proj-42"))).body.labels).toEqual({ project: "acme" });

    await make("team-b/other", { labels: { project: "zeta" } });
    const listed = await call("GET", "/v1/agents?label=project=acme");
    expect(listed.body.agents.map((item: { id: string }) => item.id)).toEqual(["team-a/proj-42"]);
    expect((await call("GET", "/v1/agents?manifest=github")).body.agents.map((item: { id: string }) => item.id)).toEqual([
      "team-a/proj-42",
    ]);
    expect((await call("GET", path("team-a/missing"))).status).toBe(404);
    expect((await make("bad id!")).status).toBe(400);
    // Only from a saved manifest: none named is a 400, an unknown one a 404.
    expect((await call("PUT", path("team-a/bare"), {})).status).toBe(400);
    const unknown = await make("team-a/unknown", { manifest: "nowhere" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("manifest_not_found");
    expect((await make("team-a/unknown", { manifest: "github@7" })).body.code).toBe("manifest_not_found");
    // The recipe fields of an Environment are the manifest's runtime section now.
    expect((await call("PUT", path("team-a/inline"), { manifest: "ws", kind: "virtual" })).status).toBe(400);
  });

  it("moves between versions of its manifest: labels and the owner guard change, another manifest is refused", async () => {
    const id = "recipe/ws";
    await save("cpu1", { kind: "virtual", resources: { cpus: 1 } });
    const created = await make(id, { manifest: "cpu1", labels: { a: "1", b: "2" } });
    expect(created.body).toMatchObject({ resolvedVersion: 1, runtime: { resources: { cpus: 1 } } });
    // The same manifest again finds it unchanged: get-or-create stays one call.
    expect((await make(id, { manifest: "cpu1" })).body).toMatchObject({ resolvedVersion: 1 });
    // Another manifest is refused, naming the fork.
    const changed = await make(id, { manifest: "ws" });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({
      code: "agent_fixed_field",
      details: { fields: [{ field: "manifest", from: "cpu1", to: "ws" }] },
    });
    expect(changed.body.message).toContain("/fork");
    // A newer version of its own manifest moves it, as it tracks the manifest; name@n pins it back.
    expect(await save("cpu1", { kind: "virtual", resources: { cpus: 1 }, lifecycle: { idle: "5m" } })).toBe(2);
    expect((await call("GET", path(id))).body).toMatchObject({ resolvedVersion: 2, runtime: { lifecycle: { idle: "5m" } } });
    expect((await make(id, { manifest: "cpu1@1" })).body).toMatchObject({ resolvedVersion: 1, manifest: "cpu1@1", tracking: "pinned" });
    expect((await call("GET", path(id))).body.runtime.lifecycle).toEqual({});
    // Labels replace and leave what it runs alone; so does the owner guard.
    const relabelled = await make(id, { manifest: "cpu1@1", labels: { c: "3" }, owner: "ada" });
    expect(relabelled.status, JSON.stringify(relabelled.body)).toBe(200);
    expect(relabelled.body).toMatchObject({ labels: { c: "3" }, owner: "ada", resolvedVersion: 1 });
    expect((await make(id, { manifest: "cpu1@1", owner: null })).body.owner).toBeNull();
    // A session opened now pins the version the Agent runs.
    const session = await open("recipe-a", id);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(session.body).toMatchObject({ agentId: id, manifest: { name: "cpu1", version: 1 } });
    // A new Agent tracking it resolves the latest; a pinned one the version it names.
    expect((await make("recipe/new", { manifest: "cpu1" })).body).toMatchObject({ resolvedVersion: 2, tracking: "tracking" });
    expect((await make("recipe/pinned", { manifest: "cpu1@1" })).body).toMatchObject({
      manifest: "cpu1@1",
      resolvedVersion: 1,
      tracking: "pinned",
    });
  });

  it("refuses pod fields in a virtual runtime section and sandbox fields in kind none, at save", async () => {
    const pod = await writeManifest(
      runtime.url,
      appHeaders,
      manifestOf(bot, { name: "fixed", runtime: { kind: "virtual", image: "python:3.13-slim", storage: "5GiB" } }),
    );
    expect(pod.status).toBe(400);
    expect(String(pod.body.message)).toContain("image is for kind pod");
    expect(String(pod.body.message)).toContain("storage is for kind pod");
    expect((await call("GET", "/v1/agent-manifests/fixed")).status).toBe(404);
    for (const field of [
      { image: "python:3.13-slim" },
      { resources: { cpus: 1 } },
      { network: { allowedHosts: ["api.github.com"] } },
    ]) {
      const refused = await writeManifest(
        runtime.url,
        appHeaders,
        manifestOf(bot, { name: "plain-refused", runtime: { kind: "none", ...field } }),
      );
      expect(refused.status, JSON.stringify(field)).toBe(400);
      expect(String(refused.body.message)).toContain("kind none has none");
    }
    expect((await call("GET", "/v1/agent-manifests/plain-refused")).status).toBe(404);
  });

  it("gives kind none no sandbox, no stop and no reset", async () => {
    await save("plain-idle", { kind: "none", lifecycle: { idle: "5m" } });
    const created = await make("plain/ws", { manifest: "plain-idle" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      kind: "none",
      state: "sleeping",
      compute: { state: "ready" },
      runtime: { harness: "nylorun", lifecycle: { idle: "5m" } },
    });
    expect(created.body.runtime.network).toBeUndefined();
    expect(created.body.runtime.resources).toBeUndefined();
    expect(created.body.disk).toBeUndefined();
    // No runtime section: kind none too.
    expect((await call("GET", path("bot"))).body.kind).toBe("none");
    const stop = await call("POST", `${path("plain/ws")}/stop`);
    expect(stop.status).toBe(400);
    expect(stop.body.message).toContain("only a pod Agent stops and resets");
    // Kind virtual neither.
    await make("plain/virtual");
    expect((await call("POST", `${path("plain/virtual")}/stop`)).status).toBe(400);
  });

  it("refuses kind pod without sandbox pods (no cluster)", async () => {
    // The manifest saves, with a warning; an Agent made from it is refused.
    const saved = await writeManifest(runtime.url, appHeaders, manifestOf(bot, { name: "pods", runtime: { kind: "pod" } }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(JSON.stringify(saved.body)).toContain("pods_unavailable");
    const refused = await make("pods/one", { manifest: "pods" });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("nylorun local sandbox enable --context");
    expect(refused.body.code).toBe("agent_unavailable");
    expect((await call("GET", path("pods/one"))).status).toBe(404);
    // Without sandbox pods, reset still says what is wrong with the Agent first:
    // a missing one is a 404, one of another kind a 400.
    expect((await call("POST", `${path("pods/missing")}/reset`)).status).toBe(404);
    await make("pods/virtual");
    const reset = await call("POST", `${path("pods/virtual")}/reset`);
    expect(reset.status).toBe(400);
    expect(reset.body.message).toContain("only a pod Agent stops and resets");
    expect((await call("POST", `${path("bot")}/reset`)).status).toBe(400);
  });

  it("refuses the session fields protocols 11 and 16 removed", async () => {
    await make("old/ws");
    for (const extra of [
      { sandbox: { id: "old/ws" } },
      { sandbox: false },
      { vaultIds: [] },
      { credentialSelections: {} },
      { environment: "old/ws" },
      { agentId: "bot" },
    ]) {
      const refused = await open("old-fields", "old/ws", { extra });
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await call("GET", "/v1/sessions/old-fields")).status).toBe(404);
  });
});

describe("sessions on an Agent", { timeout: 60_000 }, () => {
  it("share one workspace, and the Agent outlives them", async () => {
    await make("shared/ws");
    const a = await open("share-a", "shared/ws");
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ agentId: "shared/ws", manifest: { name: "ws", version: 1 } });
    for (const gone of ["environment", "sandboxId", "sandboxSource", "sandbox", "vaultIds", "credentialSelections"])
      expect(a.body).not.toHaveProperty(gone);
    expect((await open("share-b", "shared/ws", { owner: "app:bob" })).status).toBe(200);

    expect((await tool("share-a", "write", { path: "notes.txt", content: "from a" })).body).toMatchObject({
      kind: "completed",
    });
    const read = await tool("share-b", "read", { path: "notes.txt" });
    expect(JSON.stringify(read.body)).toContain("from a");

    const view = await call("GET", path("shared/ws"));
    expect(view.body.sessions.map((item: { id: string }) => item.id)).toEqual(["share-a", "share-b"]);
    expect(view.body.compute.state).toBe("running");
    expect(view.body.state).toBe("sleeping");
    // Acting for a person, only theirs.
    const theirs = await call("GET", path("shared/ws"), undefined, APP, actingFor("app:bob"));
    expect(theirs.body.sessions.map((item: { id: string }) => item.id)).toEqual(["share-b"]);

    // The session's own log records the attachment.
    const items = await call("GET", "/v1/sessions/share-a/items");
    expect(items.body.items.find((item: { type: string }) => item.type === "agent.attached")?.payload).toEqual({
      agentId: "shared/ws",
    });

    // A sessions reset deletes every session; the Agent and its files stay, detached.
    const reset = await call("POST", "/v1/tenant/reset", {
      requestId: "reset-sessions",
      scope: "sessions",
      activeWork: "cancel",
    }, runtime.managementKey);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect((await call("GET", "/v1/sessions/share-a")).status).toBe(404);
    expect((await call("GET", path("shared/ws"))).body.sessions).toEqual([]);

    expect((await open("share-c", "shared/ws")).status).toBe(200);
    expect(JSON.stringify((await tool("share-c", "read", { path: "notes.txt" })).body)).toContain("from a");

    const events = await call("GET", `${path("shared/ws")}/events`);
    expect(
      events.body.events.map((event: { type: string; seq: number; payload: Record<string, unknown> }) => [
        event.seq,
        event.type,
        event.payload.sessionId,
      ]),
    ).toEqual([
      [0, "agent.created", undefined],
      [1, "agent.attached", "share-a"],
      [2, "agent.attached", "share-b"],
      [3, "agent.detached", "share-a"],
      [4, "agent.detached", "share-b"],
      [5, "agent.attached", "share-c"],
    ]);
    expect(events.body.events[0]).toMatchObject({
      schema: "nylorun.agent-event/1",
      agentId: "shared/ws",
      payload: { kind: "virtual", labels: {}, manifest: { name: "ws", version: 1, tracking: "tracking" } },
    });
  });

  it("runs the turns of several sessions on one Agent at once (D66); disk work waits for them", async () => {
    await make("parallel/ws");
    await open("parallel-a", "parallel/ws");
    await open("parallel-b", "parallel/ws");
    await open("parallel-c", "parallel/ws");
    hold("parallel-a");
    hold("parallel-b");
    expect((await message("parallel-a")).status).toBe(200);
    // A second session's turn starts while the first runs.
    expect((await message("parallel-b")).status).toBe(200);
    // The shared workspace serves a third session while both turns run.
    expect((await tool("parallel-c", "write", { path: "c.txt", content: "c" })).status).toBe(200);
    // Both turns make the Agent working, each named in its attention.
    const working = await call("GET", path("parallel/ws"));
    expect(working.body.state).toBe("working");
    expect(working.body.attention.map((item: { sessionId?: string }) => item.sessionId).sort()).toEqual([
      "parallel-a",
      "parallel-b",
    ]);
    // Delete waits until no turn runs.
    const deleting = await call("DELETE", path("parallel/ws"));
    expect(deleting.status).toBe(409);
    expect(deleting.body.code).toBe("agent_busy");
    release("parallel-a");
    release("parallel-b");
    expect(await settled("parallel-a")).toBe("completed");
    expect(await settled("parallel-b")).toBe("completed");
    expect(JSON.stringify((await tool("parallel-a", "read", { path: "c.txt" })).body)).toContain("c");
    expect((await call("DELETE", path("parallel/ws"))).body).toEqual({ id: "parallel/ws", deleted: true });
  });

  it("filters an Agent's events by type and time", async () => {
    await make("filtered/ws");
    await open("filtered-a", "filtered/ws");
    const all = await call("GET", `${path("filtered/ws")}/events`);
    expect(all.body.events.map((event: { type: string }) => event.type)).toEqual(["agent.created", "agent.attached"]);
    const attached = await call("GET", `${path("filtered/ws")}/events?types=agent.attached,agent.egress`);
    expect(attached.body.events.map((event: { type: string }) => event.type)).toEqual(["agent.attached"]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await call("GET", `${path("filtered/ws")}/events?since=${future}`)).body.events).toEqual([]);
    expect((await call("GET", `${path("filtered/ws")}/events?until=${future}`)).body.events).toHaveLength(2);
    for (const unknown of ["egress.connection", "environment.attached"]) {
      const refused = await call("GET", `${path("filtered/ws")}/events?types=${unknown}`);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain(unknown);
    }
    expect((await call("GET", `${path("filtered/ws")}/events?since=yesterday`)).status).toBe(400);
  });

  it("delete removes the Agent and its files; a session's next turn is refused", async () => {
    await make("gone/ws");
    await open("gone-a", "gone/ws");
    await tool("gone-a", "write", { path: "f.txt", content: "x" });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: true });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: false });
    const refused = await message("gone-a");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("agent_unavailable");
    // Made again with the same id, it starts empty.
    await make("gone/ws");
    expect(JSON.stringify((await tool("gone-a", "read", { path: "f.txt" })).body)).not.toContain('"x"');
    expect((await message("gone-a")).status).toBe(200);
    expect(await settled("gone-a")).toBe("completed");
  });

  it("refuses to open a session on a missing Agent; one of kind none has no sandbox", async () => {
    expect((await open("none-env", "nowhere/ws")).status).toBe(404);
    const bare = await open("bare", "bot");
    expect(bare.status).toBe(200);
    expect(bare.body).toMatchObject({ agentId: "bot", manifest: { name: "bot", version: 1 } });
    expect((await tool("bare", "read", { path: "x" })).status).toBe(404);
  });

  it("refuses a new turn on a session opened before protocol 16, and keeps its history", async () => {
    await make("closed/ws");
    expect((await open("closed-a", "closed/ws")).status).toBe(200);
    expect((await message("closed-a")).status).toBe(200);
    expect(await settled("closed-a")).toBe("completed");
    // What migration 0032 does to a session opened before protocol 16.
    const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
    try {
      await store.tx(async (t) => {
        const stored = await t.get<Record<string, unknown>>("sessions", "closed-a");
        await t.put("sessions", "closed-a", { ...stored!, closedReason: "protocol_16" });
      });
    } finally {
      await store.close();
    }
    const refused = await message("closed-a");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("session_closed");
    expect(refused.body.message).toContain("opened before protocol 16");
    const view = await call("GET", "/v1/sessions/closed-a");
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: "completed", closedReason: "protocol_16" });
    const items = await call("GET", "/v1/sessions/closed-a/items");
    expect(items.status).toBe(200);
    expect(items.body.items.length).toBeGreaterThan(0);
  });
});

describe("the owner guard", { timeout: 60_000 }, () => {
  it("admits only its owner's sessions: 403 to an application key, 404 acting for a person", async () => {
    const guarded = await make("guard/ada", { owner: "app:ada" });
    expect(guarded.body.owner).toBe("app:ada");
    expect((await open("guard-ada", "guard/ada")).status).toBe(200);
    const app = await open("guard-bob", "guard/ada", { owner: "app:bob" });
    expect(app.status).toBe(403);
    expect(app.body.code).toBe("agent_owner_mismatch");
    const subject = await open("guard-bob", "guard/ada", { owner: "app:bob", headers: actingFor("app:bob") });
    expect(subject.status).toBe(404);
    expect(subject.body.code).not.toBe("agent_owner_mismatch");
    // A token caller with the grant: the opaque 404 too.
    const token = await mint("app:bob", "member", "guard/*");
    expect((await open("guard-bob", "guard/ada", { owner: "app:bob", key: token })).status).toBe(404);
    expect((await call("GET", "/v1/sessions/guard-bob")).status).toBe(404);
    // The owner's own, acting for herself.
    expect(
      (await open("guard-ada-2", "guard/ada", { headers: actingFor("app:ada") })).status,
    ).toBe(200);
  });

  it("lets a person set the guard only to themselves", async () => {
    const other = await make("guard/self", { owner: "app:ada" }, APP, actingFor("app:bob", "sessions:own agents:write"));
    expect(other.status).toBe(403);
    const own = await make("guard/self", { owner: "app:bob" }, APP, actingFor("app:bob", "sessions:own agents:write"));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.owner).toBe("app:bob");
  });

  it("refuses the other owner's next turn once the guard is set, until it is cleared", async () => {
    await make("guard/later");
    expect((await open("later-ada", "guard/later")).status).toBe(200);
    expect((await open("later-bob", "guard/later", { owner: "app:bob" })).status).toBe(200);
    const set = await make("guard/later", { owner: "app:ada" });
    expect(set.body).toMatchObject({ owner: "app:ada", resolvedVersion: 1 });
    const refused = await message("later-bob");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("agent_owner_mismatch");
    expect((await message("later-ada")).status).toBe(200);
    expect(await settled("later-ada")).toBe("completed");
    const cleared = await make("guard/later", { owner: null });
    expect(cleared.body.owner).toBeNull();
    expect((await message("later-bob")).status).toBe(200);
    expect(await settled("later-bob")).toBe("completed");
  });
});

describe("Agent grants", { timeout: 60_000 }, () => {
  it("exact and prefix grants decide which Agents a token opens sessions on", async () => {
    await make("grant/a/one");
    await make("grant/b/two");
    const prefix = await mint("app:gina", "member", "grant/a/*");
    expect((await open("g-1", "grant/a/one", { owner: "app:gina", key: prefix })).status).toBe(200);
    expect((await open("g-2", "grant/b/two", { owner: "app:gina", key: prefix })).status).toBe(404);
    const exact = await mint("app:gina", "member", "grant/b/two");
    expect((await open("g-3", "grant/b/two", { owner: "app:gina", key: exact })).status).toBe(200);
    // A prefix grant does not reach the prefix itself, nor a sibling with the same start.
    await make("grant/a");
    await make("grant/ab");
    expect((await open("g-4", "grant/a", { owner: "app:gina", key: prefix })).status).toBe(404);
    expect((await open("g-5", "grant/ab", { owner: "app:gina", key: prefix })).status).toBe(404);
    const none = await mint("app:gina", "member");
    expect((await open("g-6", "grant/a/one", { owner: "app:gina", key: none })).status).toBe(404);
  });

  it("checks the grant at every turn start, not only when the session was opened", async () => {
    await make("turns/a/ws");
    const granted = await mint("app:tess", "member", "turns/a/*");
    expect((await open("t-1", "turns/a/ws", { owner: "app:tess", key: granted })).status).toBe(200);
    expect((await message("t-1", granted)).status).toBe(200);
    expect(await settled("t-1")).toBe("completed");
    // The next token for the same person no longer grants the Agent: its sessions are the 404
    // of a missing one to it, as every session on an Agent its grants miss (protocol 16).
    const other = await mint("app:tess", "member", "turns/b/*");
    const refused = await message("t-1", other);
    expect(refused.status).toBe(404);
    expect((await call("GET", "/v1/sessions/t-1", undefined, other)).status).toBe(404);
    // A session the app opened for the person: the token still needs the grant.
    await open("t-2", "turns/a/ws", { owner: "app:tess" });
    expect((await message("t-2", other)).status).toBe(404);
    expect((await message("t-2", granted)).status).toBe(200);
    expect(await settled("t-2")).toBe("completed");
  });

  it("lists and reads only the Agents a token reaches", async () => {
    await make("read/a/one");
    await make("read/b/one");
    const token = await mint("app:rae", "member", "read/a/*");
    expect((await call("GET", path("read/a/one"), undefined, token)).status).toBe(200);
    expect((await call("GET", path("read/b/one"), undefined, token)).status).toBe(404);
    expect((await call("GET", `${path("read/b/one")}/events`, undefined, token)).status).toBe(404);
    expect((await call("GET", `${path("read/b/one")}/secrets`, undefined, token)).status).toBe(404);
    const listed = await call("GET", "/v1/agents", undefined, token);
    expect(listed.body.agents.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    await make("read/a/two", { labels: { project: "paging", env: "dev" } });
    await open("page-own", "read/a/two", { owner: "app:rae" });
    await open("page-other", "read/a/two", { owner: "app:other" });
    const first = await call("GET", "/v1/agents?limit=1", undefined, token);
    expect(first.status).toBe(200);
    expect(first.body.agents.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    const second = await call("GET", `/v1/agents?limit=1&cursor=${first.body.nextCursor}`, undefined, token);
    expect(second.body.agents[0].sessions.map((item: { id: string }) => item.id)).toEqual(["page-own"]);
    expect(second.body.nextCursor).toBeNull();
    const restricted = await mint("app:rae", "member", "read/b/*");
    const changed = await call("GET", `/v1/agents?limit=1&cursor=${first.body.nextCursor}`, undefined, restricted);
    expect(changed.body.agents.map((item: { id: string }) => item.id)).toEqual(["read/b/one"]);
    const filtered = await call("GET", "/v1/agents?limit=1&label=project=paging&label=env=dev", undefined, token);
    expect(filtered.body.agents.map((item: { id: string }) => item.id)).toEqual(["read/a/two"]);
    expect((await call("GET", `/v1/agents?limit=1&label=project=other&cursor=${first.body.nextCursor}`, undefined, token)).status).toBe(400);
    // Even an issuer token holding every read scope cannot use application-only reads.
    const privileged = await issuer.sign("app:rae", "sessions:own agents:read agents:write");
    for (const key of [token, privileged]) {
      for (const suffix of ["manifest", "usage", "calls/model"])
        expect((await call("GET", `/v1/sessions/page-own/${suffix}`, undefined, key)).status).toBe(403);
      expect((await call("GET", "/v1/tenant/calls/model", undefined, key)).status).toBe(403);
    }
  });
});

describe("agents:write", { timeout: 60_000 }, () => {
  it("guards create and delete through issuer tokens, within the token's grants", async () => {
    const member = await mint("app:will", "member", "write/*");
    const refused = await make("write/one", {}, member);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("scope_required");

    const builder = await mint("app:will", "builder", "write/*");
    expect((await make("write/one", {}, builder)).status).toBe(200);
    expect((await make("elsewhere/one", {}, builder)).status).toBe(404);
    expect((await call("PUT", `${path("elsewhere/one")}/secrets/TOKEN`, {
      type: "environment_variable",
      value: "v",
    }, builder)).status).toBe(404);
    expect((await call("DELETE", path("write/one"), undefined, member)).status).toBe(403);
    expect((await call("DELETE", path("write/one"), undefined, builder)).body).toEqual({
      id: "write/one",
      deleted: true,
    });
  });

  it("refuses the scope by its old names, naming the new one", async () => {
    for (const old of ["environments:write", "sandboxes:write"]) {
      const refused = await make("write/old", {}, APP, actingFor("app:will", `sessions:own ${old}`));
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("agents:write");
    }
  });
});

describe("the Tenant limit", { timeout: 60_000 }, () => {
  it("refuses an Agent past the Tenant's limit, and finds existing ones still", async () => {
    const count = (await call("GET", "/v1/agents")).body.agents.length as number;
    const saved = await call(
      "PUT",
      "/v1/tenant/sandbox",
      { limits: { environments: count + 1 } },
      runtime.managementKey,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.config.limits.environments).toBe(count + 1);
    expect((await make("limit/one")).status).toBe(200);
    const refused = await make("limit/two");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "limit_exceeded",
      details: { limit: "environments", max: count + 1 },
    });
    expect((await make("limit/one")).status).toBe(200);
    await call("PUT", "/v1/tenant/sandbox", {}, runtime.managementKey);
  });
});

describe("lifecycle.deleteAfter", { timeout: 60_000 }, () => {
  it("deletes an Agent unused that long, with its vault, and keeps one used since", async () => {
    await save("unused", { kind: "virtual", lifecycle: { deleteAfter: "2h" } });
    for (const id of ["unused/old", "unused/recent"]) {
      const created = await make(id, { manifest: "unused" });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.runtime.lifecycle).toEqual({ deleteAfter: "2h" });
      expect(
        (await call("PUT", `${path(id)}/secrets/MODE`, { type: "environment_variable", value: "x" })).status,
      ).toBe(200);
    }
    // No deleteAfter: never swept.
    await make("unused/kept");
    const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
    const removed: string[] = [];
    try {
      // "unused/old" was last used 90 minutes ago; "unused/recent" just now.
      const ninetyAgo = new Date(Date.now() - 90 * 60_000).toISOString();
      await store.tx((t) => t.updateEnvironment("unused/old", { lastUsedAt: ninetyAgo }, ninetyAgo));
      const ctx = {
        store,
        vault: new VaultService({ store, kek: () => Buffer.from(KEK, "base64") }),
        sandbox: { removeSandbox: async (id: string) => void removed.push(id) },
        config: { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
      } as unknown as TenantContext;
      // An hour from now: 2h30 since "unused/old" was used, 1h since "unused/recent".
      await sweepUnusedAgents(ctx, Date.now() + 60 * 60_000);
      // Nothing is due yet at the real time.
      await sweepUnusedAgents(ctx);
    } finally {
      await store.close();
    }
    expect(removed).toEqual(["unused/old"]);
    expect((await call("GET", path("unused/old"))).status).toBe(404);
    expect((await call("GET", `${path("unused/old")}/secrets`)).status).toBe(404);
    // Its lifecycle stream outlives it, and says why it went.
    const events = await call("GET", `${path("unused/old")}/events`);
    expect(events.body.events.at(-1)).toMatchObject({
      type: "agent.deleted",
      payload: { reason: "deleteAfter" },
    });
    expect((await call("GET", path("unused/recent"))).status).toBe(200);
    expect((await call("GET", `${path("unused/recent")}/secrets`)).body.secrets.map((s: { name: string }) => s.name)).toEqual(["MODE"]);
    expect((await call("GET", path("unused/kept"))).status).toBe(200);
  });
});
