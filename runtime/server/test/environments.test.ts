/**
 * Environments (protocol 11, D55, D56): an Environment has its own id, recipe and vault and
 * outlives the sessions that name it; sessions on one share its workspace; turns are serial per
 * Environment with a sandbox; a recipe change bumps its version; kind and storage are fixed;
 * the owner guard admits only its owner's sessions, at open and at every turn start; a token
 * caller reaches only the Environments its issuer grants, at every turn start;
 * `environments:write` guards changes; the Tenant limits how many there are; and
 * `lifecycle.deleteAfter` deletes an unused one with its vault.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { sweepUnusedEnvironments } from "../src/tenant/environments.js";
import type { TenantContext } from "../src/tenant/context.js";
import { VaultService } from "../src/vault/service.js";
import { testIssuer, type TestIssuer } from "./support/issuer.js";
import { openTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "environments-app-key-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

/** What each kind of person may do: a trusted issuer's scopes. */
const ROLES = {
  member: "sessions:own",
  builder: "sessions:own environments:write",
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

const path = (id: string) => `/v1/environments/${encodeURIComponent(id)}`;

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
  environment: string | undefined,
  options: { owner?: string; key?: string; headers?: Record<string, string>; extra?: object } = {},
): Promise<Reply> {
  return call(
    "PUT",
    `/v1/sessions/${id}`,
    {
      requestId: `open-${id}`,
      agentId: "bot",
      ownerUserId: options.owner ?? "app:ada",
      ...(environment === undefined ? {} : { environment }),
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
  issuer = await testIssuer({ environments: GRANTS });
  runtime = await startTestTenant({
    issuers: createTrustedIssuers(issuer.configs),
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    sandbox: { backend: "virtual" },
  });
  const agent = Agent({ id: "bot", name: "Bot" }).instructions("Work in the sandbox.").build();
  expect(
    (
      await call("PUT", "/v1/agents/bot", {
        requestId: "bot",
        manifest: agent.manifest,
        implementationVersion: "dev",
      })
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  await runtime?.close();
});

describe("the resource", { timeout: 60_000 }, () => {
  it("creates a virtual Environment once, by an id with slashes, and finds it again", async () => {
    const created = await call("PUT", path("team-a/proj-42"), {
      labels: { project: "acme" },
      network: { allowedHosts: ["api.github.com"] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      id: "team-a/proj-42",
      kind: "virtual",
      labels: { project: "acme" },
      state: "ready",
      sessions: [],
      version: 1,
      appliedVersion: 1,
      ownerUserId: null,
      recipe: { network: { allowedHosts: ["api.github.com"] }, harness: "nylorun", lifecycle: {} },
    });
    expect(created.body.recipe.image).toBeUndefined();
    expect(created.body.pod).toBeUndefined();
    // Idempotent: the same call, or one that sends nothing, finds it unchanged.
    const again = await call("PUT", path("team-a/proj-42"), {
      network: { allowedHosts: ["api.github.com"] },
    });
    expect(again.body).toMatchObject({
      id: "team-a/proj-42",
      createdAt: created.body.createdAt,
      version: 1,
      labels: { project: "acme" },
    });
    expect((await call("PUT", path("team-a/proj-42"), {})).body).toMatchObject({ version: 1, appliedVersion: 1 });
    expect((await call("GET", path("team-a/proj-42"))).body.labels).toEqual({ project: "acme" });

    await call("PUT", path("team-b/other"), { labels: { project: "zeta" } });
    const listed = await call("GET", "/v1/environments?label=project=acme");
    expect(listed.body.environments.map((item: { id: string }) => item.id)).toEqual(["team-a/proj-42"]);
    expect((await call("GET", path("team-a/missing"))).status).toBe(404);
    expect((await call("PUT", path("bad id!"), {})).status).toBe(400);
  });

  it("bumps the version on a recipe change, applied at once for a virtual one; labels replace", async () => {
    const id = "recipe/ws";
    expect((await call("PUT", path(id), { labels: { a: "1", b: "2" } })).body.version).toBe(1);
    const changed = await call("PUT", path(id), { resources: { cpus: 1 } });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      version: 2,
      appliedVersion: 2,
      recipe: { resources: { cpus: 1 } },
      // Labels not sent stay.
      labels: { a: "1", b: "2" },
    });
    // The same recipe again, or nothing, changes nothing.
    expect((await call("PUT", path(id), { resources: { cpus: 1 } })).body).toMatchObject({ version: 2 });
    expect((await call("PUT", path(id), {})).body).toMatchObject({ version: 2, appliedVersion: 2 });
    // Labels replace and leave the recipe's version alone.
    const relabelled = await call("PUT", path(id), { labels: { c: "3" } });
    expect(relabelled.body.labels).toEqual({ c: "3" });
    expect(relabelled.body.version).toBe(2);
    // A lifecycle change is a recipe change too.
    const lifecycle = await call("PUT", path(id), { lifecycle: { idle: "5m" } });
    expect(lifecycle.body).toMatchObject({
      version: 3,
      appliedVersion: 3,
      recipe: { resources: { cpus: 1 }, lifecycle: { idle: "5m" } },
    });
    // A session opened now pins the version it was opened on.
    const session = await open("recipe-a", id);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(session.body.environment).toEqual({ id, version: 3 });
  });

  it("fixes kind and storage, and refuses pod fields on a virtual Environment", async () => {
    await call("PUT", path("fixed/ws"), {});
    const kind = await call("PUT", path("fixed/ws"), { kind: "none" });
    expect(kind.status).toBe(409);
    expect(kind.body.message).toContain("kind");
    expect((await call("PUT", path("fixed/ws"), { kind: "virtual" })).status).toBe(200);
    const storage = await call("PUT", path("fixed/ws"), { storage: "5GiB" });
    expect(storage.status).toBe(409);
    expect(storage.body.message).toContain("storage");
    const image = await call("PUT", path("fixed/ws"), { image: "python:3.13-slim" });
    expect(image.status).toBe(400);
    expect(image.body.message).toContain("image is for kind pod");
    expect((await call("GET", path("fixed/ws"))).body.version).toBe(1);
    // A new virtual one takes neither.
    const created = await call("PUT", path("fixed/new"), { image: "python:3.13-slim", storage: "5GiB" });
    expect(created.status).toBe(400);
    expect(created.body.message).toContain("image is for kind pod");
    expect(created.body.message).toContain("storage is for kind pod");
    expect((await call("GET", path("fixed/new"))).status).toBe(404);
  });

  it("gives kind none no sandbox fields, no stop and no reset", async () => {
    for (const field of [
      { image: "python:3.13-slim" },
      { resources: { cpus: 1 } },
      { network: { allowedHosts: ["api.github.com"] } },
    ]) {
      const refused = await call("PUT", path("plain/refused"), { kind: "none", ...field });
      expect(refused.status, JSON.stringify(field)).toBe(400);
      expect(refused.body.message).toContain("kind none has none");
    }
    expect((await call("GET", path("plain/refused"))).status).toBe(404);
    const created = await call("PUT", path("plain/ws"), { kind: "none", lifecycle: { idle: "5m" } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      kind: "none",
      state: "ready",
      recipe: { harness: "nylorun", lifecycle: { idle: "5m" } },
    });
    expect(created.body.recipe.network).toBeUndefined();
    expect(created.body.recipe.resources).toBeUndefined();
    const stop = await call("POST", `${path("plain/ws")}/stop`);
    expect(stop.status).toBe(400);
    expect(stop.body.message).toContain("only a pod Environment stops and resets");
    // Kind virtual neither.
    await call("PUT", path("plain/virtual"), {});
    expect((await call("POST", `${path("plain/virtual")}/stop`)).status).toBe(400);
  });

  it("refuses kind pod without sandbox pods (no cluster)", async () => {
    const refused = await call("PUT", path("pods/one"), { kind: "pod" });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("nylorun local sandbox enable --context");
    expect(refused.body.code).toBe("environment_unavailable");
    expect((await call("GET", path("pods/one"))).status).toBe(404);
    // Without sandbox pods, reset still says what is wrong with the Environment first:
    // a missing one is a 404, one of another kind a 400.
    expect((await call("POST", `${path("pods/missing")}/reset`)).status).toBe(404);
    await call("PUT", path("pods/virtual"), {});
    const reset = await call("POST", `${path("pods/virtual")}/reset`);
    expect(reset.status).toBe(400);
    expect(reset.body.message).toContain("only a pod Environment stops and resets");
    await call("PUT", path("pods/none"), { kind: "none" });
    expect((await call("POST", `${path("pods/none")}/reset`)).status).toBe(400);
  });

  it("refuses the session fields protocol 11 removed", async () => {
    await call("PUT", path("old/ws"), {});
    for (const extra of [
      { sandbox: { id: "old/ws" } },
      { sandbox: false },
      { vaultIds: [] },
      { credentialSelections: {} },
    ]) {
      const refused = await open("old-fields", undefined, { extra });
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await call("GET", "/v1/sessions/old-fields")).status).toBe(404);
  });
});

describe("sessions on an Environment", { timeout: 60_000 }, () => {
  it("share one workspace, and the Environment outlives them", async () => {
    await call("PUT", path("shared/ws"), {});
    const a = await open("share-a", "shared/ws");
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.environment).toEqual({ id: "shared/ws", version: 1 });
    for (const gone of ["sandboxId", "sandboxSource", "sandbox", "vaultIds", "credentialSelections"])
      expect(a.body).not.toHaveProperty(gone);
    expect((await open("share-b", "shared/ws", { owner: "app:bob" })).status).toBe(200);

    expect((await tool("share-a", "write", { path: "notes.txt", content: "from a" })).body).toMatchObject({
      kind: "completed",
    });
    const read = await tool("share-b", "read", { path: "notes.txt" });
    expect(JSON.stringify(read.body)).toContain("from a");

    const view = await call("GET", path("shared/ws"));
    expect(view.body.sessions.map((item: { id: string }) => item.id)).toEqual(["share-a", "share-b"]);
    expect(view.body.state).toBe("running");
    // Acting for a person, only theirs.
    const theirs = await call("GET", path("shared/ws"), undefined, APP, actingFor("app:bob"));
    expect(theirs.body.sessions.map((item: { id: string }) => item.id)).toEqual(["share-b"]);

    // The session's own log records the attachment.
    const items = await call("GET", "/v1/sessions/share-a/items");
    expect(items.body.items.map((item: { type: string }) => item.type)).toContain("environment.attached");

    // A sessions reset deletes every session; the Environment and its files stay, detached.
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
      [0, "environment.created", undefined],
      [1, "environment.attached", "share-a"],
      [2, "environment.attached", "share-b"],
      [3, "environment.detached", "share-a"],
      [4, "environment.detached", "share-b"],
      [5, "environment.attached", "share-c"],
    ]);
    expect(events.body.events[0].environmentId).toBe("shared/ws");
  });

  it("runs one turn at a time per Environment with a sandbox, and none for kind none", async () => {
    await call("PUT", path("serial/ws"), {});
    await open("serial-a", "serial/ws");
    await open("serial-b", "serial/ws");
    hold("serial-a");
    expect((await message("serial-a")).status).toBe(200);
    const busy = await message("serial-b");
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("environment_busy");
    // Nor can it be deleted under a running turn.
    const deleting = await call("DELETE", path("serial/ws"));
    expect(deleting.status).toBe(409);
    expect(deleting.body.code).toBe("environment_busy");
    release("serial-a");
    expect(await settled("serial-a")).toBe("completed");
    expect((await message("serial-b")).status).toBe(200);
    expect(await settled("serial-b")).toBe("completed");

    // Kind none has no sandbox to share: its sessions' turns run side by side.
    await call("PUT", path("serial/none"), { kind: "none" });
    await open("none-a", "serial/none");
    await open("none-b", "serial/none");
    expect((await tool("none-a", "read", { path: "x" })).status).toBe(404);
    hold("none-a");
    expect((await message("none-a")).status).toBe(200);
    expect((await message("none-b")).status).toBe(200);
    release("none-a");
    expect(await settled("none-a")).toBe("completed");
    expect(await settled("none-b")).toBe("completed");
  });

  it("delete removes the Environment and its files; a session's next turn is refused", async () => {
    await call("PUT", path("gone/ws"), {});
    await open("gone-a", "gone/ws");
    await tool("gone-a", "write", { path: "f.txt", content: "x" });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: true });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: false });
    const refused = await message("gone-a");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("environment_unavailable");
    // Created again with the same id, it starts empty.
    await call("PUT", path("gone/ws"), {});
    expect(JSON.stringify((await tool("gone-a", "read", { path: "f.txt" })).body)).not.toContain('"x"');
    expect((await message("gone-a")).status).toBe(200);
    expect(await settled("gone-a")).toBe("completed");
  });

  it("refuses to open a session on a missing Environment; one without has no sandbox", async () => {
    expect((await open("none-env", "nowhere/ws")).status).toBe(404);
    const bare = await open("bare", undefined);
    expect(bare.status).toBe(200);
    expect(bare.body.environment).toBeNull();
    expect((await tool("bare", "read", { path: "x" })).status).toBe(404);
  });

  it("refuses a new turn on a session opened before protocol 11, and keeps its history", async () => {
    await call("PUT", path("closed/ws"), {});
    expect((await open("closed-a", "closed/ws")).status).toBe(200);
    expect((await message("closed-a")).status).toBe(200);
    expect(await settled("closed-a")).toBe("completed");
    // What migration 0020 does to a session opened before protocol 11.
    const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
    try {
      await store.tx(async (t) => {
        const stored = await t.get<Record<string, unknown>>("sessions", "closed-a");
        const { environmentId: _e, environmentVersion: _v, sandbox: _s, ...rest } = stored!;
        await t.put("sessions", "closed-a", { ...rest, closedReason: "protocol_11" });
      });
    } finally {
      await store.close();
    }
    const refused = await message("closed-a");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("session_closed");
    expect(refused.body.message).toContain("open a new session that names an Environment");
    const view = await call("GET", "/v1/sessions/closed-a");
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: "completed", closedReason: "protocol_11", environment: null });
    const items = await call("GET", "/v1/sessions/closed-a/items");
    expect(items.status).toBe(200);
    expect(items.body.items.length).toBeGreaterThan(0);
  });
});

describe("the owner guard", { timeout: 60_000 }, () => {
  it("admits only its owner's sessions: 403 to an application key, 404 acting for a person", async () => {
    const guarded = await call("PUT", path("guard/ada"), { ownerUserId: "app:ada" });
    expect(guarded.body.ownerUserId).toBe("app:ada");
    expect((await open("guard-ada", "guard/ada")).status).toBe(200);
    const app = await open("guard-bob", "guard/ada", { owner: "app:bob" });
    expect(app.status).toBe(403);
    expect(app.body.code).toBe("environment_owner_mismatch");
    const subject = await open("guard-bob", "guard/ada", { owner: "app:bob", headers: actingFor("app:bob") });
    expect(subject.status).toBe(404);
    expect(subject.body.code).not.toBe("environment_owner_mismatch");
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
    const other = await call(
      "PUT",
      path("guard/self"),
      { ownerUserId: "app:ada" },
      APP,
      actingFor("app:bob", "sessions:own environments:write"),
    );
    expect(other.status).toBe(403);
    const own = await call(
      "PUT",
      path("guard/self"),
      { ownerUserId: "app:bob" },
      APP,
      actingFor("app:bob", "sessions:own environments:write"),
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.ownerUserId).toBe("app:bob");
  });

  it("refuses the other owner's next turn once the guard is set, until it is cleared", async () => {
    await call("PUT", path("guard/later"), {});
    expect((await open("later-ada", "guard/later")).status).toBe(200);
    expect((await open("later-bob", "guard/later", { owner: "app:bob" })).status).toBe(200);
    const set = await call("PUT", path("guard/later"), { ownerUserId: "app:ada" });
    expect(set.body).toMatchObject({ ownerUserId: "app:ada", version: 1 });
    const refused = await message("later-bob");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("environment_owner_mismatch");
    expect((await message("later-ada")).status).toBe(200);
    expect(await settled("later-ada")).toBe("completed");
    const cleared = await call("PUT", path("guard/later"), { ownerUserId: null });
    expect(cleared.body.ownerUserId).toBeNull();
    expect((await message("later-bob")).status).toBe(200);
    expect(await settled("later-bob")).toBe("completed");
  });
});

describe("Environment grants", { timeout: 60_000 }, () => {
  it("exact and prefix grants decide which Environments a token opens sessions on", async () => {
    await call("PUT", path("grant/a/one"), {});
    await call("PUT", path("grant/b/two"), {});
    const prefix = await mint("app:gina", "member", "grant/a/*");
    expect((await open("g-1", "grant/a/one", { owner: "app:gina", key: prefix })).status).toBe(200);
    expect((await open("g-2", "grant/b/two", { owner: "app:gina", key: prefix })).status).toBe(404);
    const exact = await mint("app:gina", "member", "grant/b/two");
    expect((await open("g-3", "grant/b/two", { owner: "app:gina", key: exact })).status).toBe(200);
    // A prefix grant does not reach the prefix itself, nor a sibling with the same start.
    await call("PUT", path("grant/a"), {});
    await call("PUT", path("grant/ab"), {});
    expect((await open("g-4", "grant/a", { owner: "app:gina", key: prefix })).status).toBe(404);
    expect((await open("g-5", "grant/ab", { owner: "app:gina", key: prefix })).status).toBe(404);
    const none = await mint("app:gina", "member");
    expect((await open("g-6", "grant/a/one", { owner: "app:gina", key: none })).status).toBe(404);
  });

  it("checks the grant at every turn start, not only when the session was opened", async () => {
    await call("PUT", path("turns/a/ws"), {});
    const granted = await mint("app:tess", "member", "turns/a/*");
    expect((await open("t-1", "turns/a/ws", { owner: "app:tess", key: granted })).status).toBe(200);
    expect((await message("t-1", granted)).status).toBe(200);
    expect(await settled("t-1")).toBe("completed");
    // The next token for the same person no longer grants the Environment.
    const other = await mint("app:tess", "member", "turns/b/*");
    const refused = await message("t-1", other);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("environment_not_granted");
    // A session the app opened for the person: the token still needs the grant.
    await open("t-2", "turns/a/ws", { owner: "app:tess" });
    expect((await message("t-2", other)).body.code).toBe("environment_not_granted");
    expect((await message("t-2", granted)).status).toBe(200);
    expect(await settled("t-2")).toBe("completed");
  });

  it("lists and reads only the Environments a token reaches", async () => {
    await call("PUT", path("read/a/one"), {});
    await call("PUT", path("read/b/one"), {});
    const token = await mint("app:rae", "member", "read/a/*");
    expect((await call("GET", path("read/a/one"), undefined, token)).status).toBe(200);
    expect((await call("GET", path("read/b/one"), undefined, token)).status).toBe(404);
    expect((await call("GET", `${path("read/b/one")}/events`, undefined, token)).status).toBe(404);
    expect((await call("GET", `${path("read/b/one")}/secrets`, undefined, token)).status).toBe(404);
    const listed = await call("GET", "/v1/environments", undefined, token);
    expect(listed.body.environments.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    await call("PUT", path("read/a/two"), { labels: { project: "paging", env: "dev" } });
    await open("page-own", "read/a/two", { owner: "app:rae" });
    await open("page-other", "read/a/two", { owner: "app:other" });
    const first = await call("GET", "/v1/environments?limit=1", undefined, token);
    expect(first.status).toBe(200);
    expect(first.body.environments.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    const second = await call("GET", `/v1/environments?limit=1&cursor=${first.body.nextCursor}`, undefined, token);
    expect(second.body.environments[0].sessions.map((item: { id: string }) => item.id)).toEqual(["page-own"]);
    expect(second.body.nextCursor).toBeNull();
    const restricted = await mint("app:rae", "member", "read/b/*");
    const changed = await call("GET", `/v1/environments?limit=1&cursor=${first.body.nextCursor}`, undefined, restricted);
    expect(changed.body.environments.map((item: { id: string }) => item.id)).toEqual(["read/b/one"]);
    const filtered = await call("GET", "/v1/environments?limit=1&label=project=paging&label=env=dev", undefined, token);
    expect(filtered.body.environments.map((item: { id: string }) => item.id)).toEqual(["read/a/two"]);
    expect((await call("GET", `/v1/environments?limit=1&label=project=other&cursor=${first.body.nextCursor}`, undefined, token)).status).toBe(400);
    // Even an issuer token holding every read scope cannot use application-only reads.
    const privileged = await issuer.sign("app:rae", "sessions:own agents:read agents:write");
    for (const key of [token, privileged]) {
      for (const suffix of ["manifest", "usage", "calls/model"])
        expect((await call("GET", `/v1/sessions/page-own/${suffix}`, undefined, key)).status).toBe(403);
      expect((await call("GET", "/v1/tenant/calls/model", undefined, key)).status).toBe(403);
    }
  });
});

describe("environments:write", { timeout: 60_000 }, () => {
  it("guards create and delete through issuer tokens, within the token's grants", async () => {
    const member = await mint("app:will", "member", "write/*");
    const refused = await call("PUT", path("write/one"), {}, member);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("scope_required");

    const builder = await mint("app:will", "builder", "write/*");
    expect((await call("PUT", path("write/one"), {}, builder)).status).toBe(200);
    expect((await call("PUT", path("elsewhere/one"), {}, builder)).status).toBe(404);
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

  it("refuses the protocol 10 scope by its old name, naming the new one", async () => {
    const refused = await call("PUT", path("write/old"), {}, APP, actingFor("app:will", "sessions:own sandboxes:write"));
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("environments:write");
  });
});

describe("the Tenant limit", { timeout: 60_000 }, () => {
  it("refuses an Environment past the Tenant's limit, and finds existing ones still", async () => {
    const count = (await call("GET", "/v1/environments")).body.environments.length as number;
    const saved = await call(
      "PUT",
      "/v1/tenant/sandbox",
      { limits: { environments: count + 1 } },
      runtime.managementKey,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.config.limits.environments).toBe(count + 1);
    expect((await call("PUT", path("limit/one"), {})).status).toBe(200);
    const refused = await call("PUT", path("limit/two"), {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "limit_exceeded",
      details: { limit: "environments", max: count + 1 },
    });
    expect((await call("PUT", path("limit/one"), {})).status).toBe(200);
    await call("PUT", "/v1/tenant/sandbox", {}, runtime.managementKey);
  });
});

describe("lifecycle.deleteAfter", { timeout: 60_000 }, () => {
  it("deletes an Environment unused that long, with its vault, and keeps one used since", async () => {
    for (const id of ["unused/old", "unused/recent"]) {
      const created = await call("PUT", path(id), { lifecycle: { deleteAfter: "2h" } });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.recipe.lifecycle).toEqual({ deleteAfter: "2h" });
      expect(
        (await call("PUT", `${path(id)}/secrets/MODE`, { type: "environment_variable", value: "x" })).status,
      ).toBe(200);
    }
    // No deleteAfter: never swept.
    await call("PUT", path("unused/kept"), {});
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
      await sweepUnusedEnvironments(ctx, Date.now() + 60 * 60_000);
      // Nothing is due yet at the real time.
      await sweepUnusedEnvironments(ctx);
    } finally {
      await store.close();
    }
    expect(removed).toEqual(["unused/old"]);
    expect((await call("GET", path("unused/old"))).status).toBe(404);
    expect((await call("GET", `${path("unused/old")}/secrets`)).status).toBe(404);
    // Its lifecycle stream outlives it, and says why it went.
    const events = await call("GET", `${path("unused/old")}/events`);
    expect(events.body.events.at(-1)).toMatchObject({
      type: "environment.deleted",
      payload: { reason: "deleteAfter" },
    });
    expect((await call("GET", path("unused/recent"))).status).toBe(200);
    expect((await call("GET", `${path("unused/recent")}/secrets`)).body.secrets.map((s: { name: string }) => s.name)).toEqual(["MODE"]);
    expect((await call("GET", path("unused/kept"))).status).toBe(200);
  });
});
