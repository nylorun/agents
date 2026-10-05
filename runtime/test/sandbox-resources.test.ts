/**
 * Sandboxes as a resource (F7.1, blueprint D39; Host feature `sandboxes`): a sandbox has its own
 * id and outlives the sessions attached to it, sessions attached to one share its workspace,
 * turns are serial per sandbox, a token caller reaches only the sandboxes its issuer grants, at
 * every turn start, `sandboxes:write` guards changes, and the Tenant limits how many there are.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { createTrustedIssuers } from "../src/tenant/issuers.js";
import { testIssuer, type TestIssuer } from "./support/issuer.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "sandbox-resources-app-key-aaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

/** What each kind of person may do: a trusted issuer's scopes. */
const ROLES = {
  member: "sessions:own",
  builder: "sessions:own sandboxes:write",
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
): Promise<Reply> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
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

const path = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;

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
  sandbox: unknown,
  options: { owner?: string; key?: string } = {},
): Promise<Reply> {
  return call(
    "PUT",
    `/v1/sessions/${id}`,
    { requestId: `open-${id}`, agentId: "bot", ownerUserId: options.owner ?? "app:ada", sandbox },
    options.key,
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
  issuer = await testIssuer({ sandboxes: GRANTS });
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
  it("creates a virtual sandbox once, by an id with slashes, and finds it again", async () => {
    const created = await call("PUT", path("team-a/proj-42"), {
      labels: { project: "acme" },
      network: { allow: ["api.github.com"] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      id: "team-a/proj-42",
      kind: "virtual",
      labels: { project: "acme" },
      state: "ready",
      sessions: [],
      spec: { network: { preset: "none", allow: ["api.github.com"] } },
    });
    // Idempotent: the same call, or one that sends no spec, finds it.
    expect((await call("PUT", path("team-a/proj-42"), { network: { allow: ["api.github.com"] } })).body).toMatchObject({
      id: "team-a/proj-42",
      createdAt: created.body.createdAt,
    });
    expect((await call("PUT", path("team-a/proj-42"), {})).status).toBe(200);
    // Its spec is fixed.
    expect((await call("PUT", path("team-a/proj-42"), { resources: { cpus: 3 } })).status).toBe(409);
    expect((await call("GET", path("team-a/proj-42"))).body.labels).toEqual({ project: "acme" });

    await call("PUT", path("team-b/other"), { labels: { project: "zeta" } });
    const listed = await call("GET", "/v1/sandboxes?label=project=acme");
    expect(listed.body.sandboxes.map((item: { id: string }) => item.id)).toEqual(["team-a/proj-42"]);
    expect((await call("GET", path("team-a/missing"))).status).toBe(404);
    expect((await call("PUT", path("bad id!"), {})).status).toBe(400);
  });

  it("refuses kind pod without sandbox pods (no cluster)", async () => {
    const refused = await call("PUT", path("pods/one"), { kind: "pod" });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("nylorun sandbox enable --context");
    expect(refused.body.code).toBe("sandbox_unavailable");
    expect((await call("GET", path("pods/one"))).status).toBe(404);
  });
});

describe("sessions attached to a sandbox", { timeout: 60_000 }, () => {
  it("share one workspace, and the sandbox outlives them", async () => {
    await call("PUT", path("shared/ws"), {});
    const a = await open("share-a", { id: "shared/ws" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ sandboxId: "shared/ws", sandboxSource: "sandbox" });
    expect((await open("share-b", { id: "shared/ws" }, { owner: "app:bob" })).status).toBe(200);

    expect((await tool("share-a", "write", { path: "notes.txt", content: "from a" })).body).toMatchObject({
      kind: "completed",
    });
    const read = await tool("share-b", "read", { path: "notes.txt" });
    expect(JSON.stringify(read.body)).toContain("from a");

    const view = await call("GET", path("shared/ws"));
    expect(view.body.sessions.map((item: { id: string }) => item.id)).toEqual(["share-a", "share-b"]);
    expect(view.body.state).toBe("running");

    // The session's own log records the attachment.
    const items = await call("GET", "/v1/sessions/share-a/items");
    expect(items.body.items.map((item: { type: string }) => item.type)).toContain("sandbox.attached");

    // A sessions reset deletes every session; the sandbox and its files stay, detached.
    const reset = await call("POST", "/v1/tenant/reset", {
      requestId: "reset-sessions",
      scope: "sessions",
      activeWork: "cancel",
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect((await call("GET", "/v1/sessions/share-a")).status).toBe(404);
    expect((await call("GET", path("shared/ws"))).body.sessions).toEqual([]);

    expect((await open("share-c", { id: "shared/ws" })).status).toBe(200);
    expect(JSON.stringify((await tool("share-c", "read", { path: "notes.txt" })).body)).toContain("from a");

    const events = await call("GET", `${path("shared/ws")}/events`);
    expect(
      events.body.events.map((event: { type: string; seq: number; payload: Record<string, unknown> }) => [
        event.seq,
        event.type,
        event.payload.sessionId,
      ]),
    ).toEqual([
      [0, "sandbox.created", undefined],
      [1, "sandbox.attached", "share-a"],
      [2, "sandbox.attached", "share-b"],
      [3, "sandbox.detached", "share-a"],
      [4, "sandbox.detached", "share-b"],
      [5, "sandbox.attached", "share-c"],
    ]);
  });

  it("runs one turn at a time per sandbox", async () => {
    await call("PUT", path("serial/ws"), {});
    await open("serial-a", { id: "serial/ws" });
    await open("serial-b", { id: "serial/ws" });
    hold("serial-a");
    expect((await message("serial-a")).status).toBe(200);
    const busy = await message("serial-b");
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("sandbox_busy");
    // Nor can it be deleted under a running turn.
    expect((await call("DELETE", path("serial/ws"))).body.code).toBe("sandbox_busy");
    release("serial-a");
    expect(await settled("serial-a")).toBe("completed");
    expect((await message("serial-b")).status).toBe(200);
    expect(await settled("serial-b")).toBe("completed");
  });

  it("delete removes the sandbox and its files; an attached session's next turn is refused", async () => {
    await call("PUT", path("gone/ws"), {});
    await open("gone-a", { id: "gone/ws" });
    await tool("gone-a", "write", { path: "f.txt", content: "x" });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: true });
    expect((await call("DELETE", path("gone/ws"))).body).toEqual({ id: "gone/ws", deleted: false });
    const refused = await message("gone-a");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("sandbox_unavailable");
    // Created again with the same id, it starts empty.
    await call("PUT", path("gone/ws"), {});
    expect(JSON.stringify((await tool("gone-a", "read", { path: "f.txt" })).body)).not.toContain('"x"');
    expect((await message("gone-a")).status).toBe(200);
    expect(await settled("gone-a")).toBe("completed");
  });

  it("refuses to attach a missing sandbox, or to share a session that is attached to one", async () => {
    expect((await open("none-a", { id: "nowhere/ws" })).status).toBe(404);
    await call("PUT", path("share/by-id"), {});
    await open("by-id-a", { id: "share/by-id" });
    const refused = await open("by-id-b", { session: "by-id-a" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('sandbox: { id: "share/by-id" }');
  });
});

describe("sandbox grants", { timeout: 60_000 }, () => {
  it("exact and prefix grants decide which sandboxes a token attaches to", async () => {
    await call("PUT", path("grant/a/one"), {});
    await call("PUT", path("grant/b/two"), {});
    const prefix = await mint("app:gina", "member", "grant/a/*");
    expect((await open("g-1", { id: "grant/a/one" }, { owner: "app:gina", key: prefix })).status).toBe(200);
    expect((await open("g-2", { id: "grant/b/two" }, { owner: "app:gina", key: prefix })).status).toBe(404);
    const exact = await mint("app:gina", "member", "grant/b/two");
    expect((await open("g-3", { id: "grant/b/two" }, { owner: "app:gina", key: exact })).status).toBe(200);
    // A prefix grant does not reach the prefix itself, nor a sibling with the same start.
    await call("PUT", path("grant/a"), {});
    await call("PUT", path("grant/ab"), {});
    expect((await open("g-4", { id: "grant/a" }, { owner: "app:gina", key: prefix })).status).toBe(404);
    expect((await open("g-5", { id: "grant/ab" }, { owner: "app:gina", key: prefix })).status).toBe(404);
    const none = await mint("app:gina", "member");
    expect((await open("g-6", { id: "grant/a/one" }, { owner: "app:gina", key: none })).status).toBe(404);
  });

  it("checks the grant at every turn start, not only when the session was opened", async () => {
    await call("PUT", path("turns/a/ws"), {});
    const granted = await mint("app:tess", "member", "turns/a/*");
    expect((await open("t-1", { id: "turns/a/ws" }, { owner: "app:tess", key: granted })).status).toBe(200);
    expect((await message("t-1", granted)).status).toBe(200);
    expect(await settled("t-1")).toBe("completed");
    // The next token for the same person no longer grants the sandbox.
    const other = await mint("app:tess", "member", "turns/b/*");
    const refused = await message("t-1", other);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("sandbox_not_granted");
    // A session the app opened for the person: the token still needs the grant.
    await open("t-2", { id: "turns/a/ws" }, { owner: "app:tess" });
    expect((await message("t-2", other)).body.code).toBe("sandbox_not_granted");
    expect((await message("t-2", granted)).status).toBe(200);
    expect(await settled("t-2")).toBe("completed");
  });

  it("lists and reads only the sandboxes a token reaches", async () => {
    await call("PUT", path("read/a/one"), {});
    await call("PUT", path("read/b/one"), {});
    const token = await mint("app:rae", "member", "read/a/*");
    expect((await call("GET", path("read/a/one"), undefined, token)).status).toBe(200);
    expect((await call("GET", path("read/b/one"), undefined, token)).status).toBe(404);
    const listed = await call("GET", "/v1/sandboxes", undefined, token);
    expect(listed.body.sandboxes.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    await call("PUT", path("read/a/two"), { labels: { project: "paging", env: "dev" } });
    await open("page-own", { id: "read/a/two" }, { owner: "app:rae" });
    await open("page-other", { id: "read/a/two" }, { owner: "app:other" });
    const first = await call("GET", "/v1/sandboxes?limit=1", undefined, token);
    expect(first.status).toBe(200);
    expect(first.body.sandboxes.map((item: { id: string }) => item.id)).toEqual(["read/a/one"]);
    const second = await call("GET", `/v1/sandboxes?limit=1&cursor=${first.body.nextCursor}`, undefined, token);
    expect(second.body.sandboxes[0].sessions.map((item: { id: string }) => item.id)).toEqual(["page-own"]);
    expect(second.body.nextCursor).toBeNull();
    const restricted = await mint("app:rae", "member", "read/b/*");
    const changed = await call("GET", `/v1/sandboxes?limit=1&cursor=${first.body.nextCursor}`, undefined, restricted);
    expect(changed.body.sandboxes.map((item: {id: string}) => item.id)).toEqual(["read/b/one"]);
    const filtered = await call("GET", "/v1/sandboxes?limit=1&label=project=paging&label=env=dev", undefined, token);
    expect(filtered.body.sandboxes.map((item: { id: string }) => item.id)).toEqual(["read/a/two"]);
    expect((await call("GET", `/v1/sandboxes?limit=1&label=project=other&cursor=${first.body.nextCursor}`, undefined, token)).status).toBe(400);
    // Even an issuer token holding every read scope cannot use application-only reads.
    const privileged = await issuer.sign("app:rae", "sessions:own agents:read tenant:settings");
    for (const key of [token, privileged]) {
      for (const suffix of ["manifest", "usage", "calls/model"])
        expect((await call("GET", `/v1/sessions/page-own/${suffix}`, undefined, key)).status).toBe(403);
      expect((await call("GET", "/v1/tenant/calls/model", undefined, key)).status).toBe(403);
    }

  });
});

describe("sandboxes:write", { timeout: 60_000 }, () => {
  it("guards create and delete through issuer tokens, within the token's grants", async () => {
    const member = await mint("app:will", "member", "write/*");
    const refused = await call("PUT", path("write/one"), {}, member);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("scope_required");

    const builder = await mint("app:will", "builder", "write/*");
    expect((await call("PUT", path("write/one"), {}, builder)).status).toBe(200);
    expect((await call("PUT", path("elsewhere/one"), {}, builder)).status).toBe(404);
    expect((await call("DELETE", path("write/one"), undefined, member)).status).toBe(403);
    expect((await call("DELETE", path("write/one"), undefined, builder)).body).toEqual({
      id: "write/one",
      deleted: true,
    });
  });
});

describe("the Tenant limit", { timeout: 60_000 }, () => {
  it("refuses a sandbox past the Tenant's limit, and finds existing ones still", async () => {
    const count = (await call("GET", "/v1/sandboxes")).body.sandboxes.length as number;
    const saved = await call("PUT", "/v1/tenant/sandbox", { limits: { sandboxes: count + 1 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.config.limits.sandboxes).toBe(count + 1);
    expect((await call("PUT", path("limit/one"), {})).status).toBe(200);
    const refused = await call("PUT", path("limit/two"), {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "limit_exceeded",
      details: { limit: "sandboxes", max: count + 1 },
    });
    expect((await call("PUT", path("limit/one"), {})).status).toBe(200);
    await call("PUT", "/v1/tenant/sandbox", {});
  });
});
