/**
 * Agent manifests (protocol 16, track T2): versions saved with `If-Match` and a dry-run plan by
 * section; the checks between the harness and runtime sections (`422 manifest_inconsistent`);
 * Agents made from one version, tracking (a save moves them) or pinned (a save leaves them);
 * secret slots, written by value; and forks onto a newer version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { AgentManifestV8 } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { manifestOf } from "./support/agents.js";

const APP = "manifests-app-key-aaaaaaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");

interface Reply {
  status: number;
  body: any;
}

const model: ModelProvider = async () => ({ output: [{ type: "text", text: "ok" }] });
let runtime: Awaited<ReturnType<typeof startTestTenant>>;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json", ...headers },
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

const manifests = (name: string, rest = "") => `/v1/agent-manifests/${name}${rest}`;
const agents = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;
const bot = Agent({ id: "bot", name: "Bot" }).instructions("Work.").build();
/** A manifest named `name` running `bot` on a virtual runtime with `runtime`'s fields. */
const box = (name = "box", runtime: Record<string, unknown> = {}, top: Partial<AgentManifestV8> = {}): AgentManifestV8 => ({
  ...manifestOf(bot, { name, runtime: { kind: "virtual", network: { allowedHosts: ["api.github.com"] }, ...runtime } as never }),
  ...top,
});

function open(id: string, agent: string): Promise<Reply> {
  return call("PUT", `/v1/sessions/${id}`, { requestId: `open-${id}`, agent, ownerUserId: "app:ada" });
}

beforeAll(async () => {
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    sandbox: { backend: "virtual" },
  });
});

afterAll(async () => {
  await runtime?.close();
});

describe("saving", () => {
  it("saves versions, answers an unchanged save as it is, and lists them", async () => {
    const first = await call("PUT", manifests("box"), box());
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      unchanged: false,
      warnings: [],
      manifest: { name: "box", version: 1, savedBy: { actor: "application" }, agents: 0 },
    });
    expect(first.body.manifest.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await call("PUT", manifests("box"), box());
    expect(again.body).toMatchObject({ unchanged: true, manifest: { version: 1, hash: first.body.manifest.hash } });
    const second = await call("PUT", manifests("box"), box("box", {}, { description: "With a description" }));
    expect(second.body).toMatchObject({ unchanged: false, manifest: { version: 2 } });
    expect((await call("GET", manifests("box"))).body).toMatchObject({ version: 2, manifest: { description: "With a description" } });
    expect((await call("GET", manifests("box", "/versions/1"))).body.manifest.description).toBeUndefined();
    const versions = await call("GET", manifests("box", "/versions"));
    expect(versions.body).toMatchObject({ name: "box", latest: 2 });
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await call("GET", "/v1/agent-manifests")).body.manifests.map((m: { name: string }) => m.name)).toContain("box");
    expect((await call("GET", manifests("box", "/versions/9"))).body).toMatchObject({ code: "manifest_not_found" });
    expect((await call("GET", manifests("missing"))).status).toBe(404);
  });

  it("refuses a manifest whose name is not the path's, a version it does not know, or $schema", async () => {
    expect((await call("PUT", manifests("other"), box())).status).toBe(400);
    const version = await call("PUT", manifests("box"), { ...box(), manifestSchemaVersion: 7 });
    expect(version.status).toBe(400);
    expect(JSON.stringify(version.body)).toContain("nylorun migrate v8");
    expect((await call("PUT", manifests("box"), { ...box(), $schema: "x" })).status).toBe(400);
    // Definitions and environment manifests are gone.
    expect((await call("PUT", "/v1/environment-manifests/box", {})).status).toBe(404);
  });

  it("refuses a save over a version the saver has not read (If-Match)", async () => {
    expect((await call("PUT", manifests("gated"), box("gated"), { "if-match": "0" })).status).toBe(200);
    const stale = await call("PUT", manifests("gated"), box("gated", {}, { description: "x" }), { "if-match": "0" });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: "manifest_changed", details: { latest: 1 } });
    expect((await call("PUT", manifests("gated"), box("gated", {}, { description: "x" }), { "if-match": "1" })).body.manifest.version).toBe(2);
    expect((await call("PUT", manifests("fresh"), box("fresh"), { "if-match": "3" })).status).toBe(412);
  });

  it("plans a save with dryRun: changes by section, errors, warnings and the Agents behind", async () => {
    await call("PUT", manifests("planned"), box("planned"));
    expect((await call("PUT", agents("planned/one"), { manifest: "planned" })).status).toBe(200);
    const next = box("planned", { network: { allowedHosts: ["api.github.com", "pypi.org"] }, kind: "pod", image: "python:3.13-slim" });
    const plan = await call("PUT", `${manifests("planned")}?dryRun=true`, {
      ...next,
      harness: { ...next.harness, instructions: ["Work harder."] },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    // A tracking Agent of kind virtual cannot move to kind pod (a fixed field): it stays behind.
    expect(plan.body).toMatchObject({ name: "planned", from: 1, to: 2, unchanged: false, errors: [], behind: 1, moves: { now: 0, nextStart: 0, secrets: 0 } });
    expect(plan.body.changes.map((change: { section: string; path: string; op: string }) => `${change.section} ${change.path} ${change.op}`)).toEqual([
      "harness instructions replace",
      "runtime image add",
      "runtime kind replace",
      "runtime network.allowedHosts replace",
    ]);
    expect(plan.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(["image_tag", "pods_unavailable", "agents_behind"]);
    expect(plan.body.warnings.at(-1).message).toContain("1 Agent stays on an older version of planned");
    // Nothing was saved.
    expect((await call("GET", manifests("planned"))).body.version).toBe(1);
    const tooBig = box("planned", { resources: { cpus: 64 } });
    const refused = await call("PUT", `${manifests("planned")}?dryRun=true`, tooBig);
    expect(refused.body.errors.join(" ")).toContain("resources.cpus");
    expect((await call("PUT", manifests("planned"), tooBig)).status).toBe(400);
  });
});

describe("the checks between the sections", () => {
  it("refuses an MCP server whose credential is no declared slot, naming every gap in one 422", async () => {
    const manifest: AgentManifestV8 = {
      manifestSchemaVersion: 8,
      name: "linear",
      harness: {
        instructions: ["Triage."],
        mcpServers: {
          linear: { name: "linear", type: "streamable-http", url: "https://mcp.linear.app/mcp", credential: "LINEAR_KEY" },
        },
        skills: {
          notes: { name: "notes", description: "Takes notes", files: { "SKILL.md": `sha256:${"a".repeat(64)}` } },
        },
      },
      runtime: { kind: "none" },
    };
    const refused = await call("PUT", manifests("linear"), manifest);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({
      code: "manifest_inconsistent",
      details: {
        gaps: [
          'harness.mcpServers.linear.credential "LINEAR_KEY" is not a secret slot in runtime.secrets',
          'harness.skills needs a sandbox; runtime.kind "none" has none',
        ],
      },
    });
    // The plan reports them as errors, first; nothing is saved.
    const plan = await call("PUT", `${manifests("linear")}?dryRun=true`, manifest);
    expect(plan.body.errors.slice(0, 2)).toEqual(refused.body.details.gaps);
    expect((await call("GET", manifests("linear"))).status).toBe(404);
    // A custom harness needs a pod with an image.
    const custom = await call("PUT", manifests("custom"), { ...box("custom"), harness: { id: "acme-loop" } });
    expect(custom.body.details.gaps).toEqual(['harness.id "acme-loop" needs runtime.kind "pod"; the runtime is "virtual"']);
  });

  it("saves the server once the slot is declared, bound to the server's URL", async () => {
    const saved = await call("PUT", manifests("linear-ok"), {
      manifestSchemaVersion: 8,
      name: "linear-ok",
      harness: {
        mcpServers: {
          linear: { name: "linear", type: "streamable-http", url: "https://mcp.linear.app/mcp", credential: "LINEAR_KEY" },
        },
      },
      runtime: { kind: "none", secrets: { LINEAR_KEY: { type: "bearer", url: "https://mcp.linear.app/mcp", required: true } } },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // Without a runtime section, an Agent of kind none: a vault and nothing else.
    const bare = await call("PUT", manifests("bare"), { manifestSchemaVersion: 8, name: "bare", harness: { instructions: ["Hi."] } });
    expect(bare.status).toBe(200);
    const agent = await call("PUT", agents("bare"), { manifest: "bare" });
    expect(agent.body).toMatchObject({ kind: "none", slots: [], compute: { state: "ready" } });
    expect(agent.body.disk).toBeUndefined();
  });

  it("takes schedule, at and webhook triggers, and selfWake", async () => {
    const saved = await call("PUT", manifests("woken"), box("woken", { triggers: { daily: { schedule: "0 9 * * *", session: "s", prompt: "Wake." } } }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const hook = await call("PUT", manifests("hooked"), box("hooked", { triggers: { h: { webhook: "standard-webhooks", session: "s", prompt: "x" } } }));
    expect(hook.status, JSON.stringify(hook.body)).toBe(200);
    const other = await call("PUT", manifests("github"), box("github", { triggers: { h: { webhook: "github", session: "s", prompt: "x" } } }));
    expect(other.status).toBe(400);
    const self = await call("PUT", manifests("self"), box("self", { selfWake: true }));
    expect(self.status, JSON.stringify(self.body)).toBe(200);
  });
});

describe("Agents made from a manifest", () => {
  it("moves a tracking Agent on each save, keeps a pinned one, and refuses another manifest", async () => {
    await call("PUT", manifests("pinned"), box("pinned", { lifecycle: { idle: "5m" } }));
    const made = await call("PUT", agents("pinned/one"), { manifest: "pinned", labels: { team: "a" }, owner: "app:ada" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({
      id: "pinned/one",
      manifest: "pinned",
      resolvedVersion: 1,
      tracking: "tracking",
      kind: "virtual",
      harness: "nylorun",
      owner: "app:ada",
      labels: { team: "a" },
      state: "sleeping",
      attention: [],
      desired: "on",
      compute: { state: "ready" },
      runtime: { network: { allowedHosts: ["api.github.com"] }, lifecycle: { idle: "5m" } },
      sessions: [],
      forkedFrom: null,
    });
    // Pinned to version 1 by name@n: the next save leaves it there.
    expect((await call("PUT", agents("pinned/one"), { manifest: "pinned@1" })).body).toMatchObject({ resolvedVersion: 1, tracking: "pinned" });
    const saved = await call("PUT", manifests("pinned"), box("pinned", { lifecycle: { idle: "10m" } }));
    expect(saved.body.manifest.version).toBe(2);
    expect(saved.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(["agents_behind"]);
    const again = await call("PUT", agents("pinned/one"), { manifest: "pinned@1", labels: { team: "b" } });
    expect(again.body).toMatchObject({ resolvedVersion: 1, runtime: { lifecycle: { idle: "5m" } }, labels: { team: "b" } });
    // A bare name tracks: it moves to the latest at once (kind virtual), and with each save after.
    const tracked = await call("PUT", agents("pinned/one"), { manifest: "pinned" });
    expect(tracked.body).toMatchObject({ resolvedVersion: 2, tracking: "tracking", targetVersion: null, runtime: { lifecycle: { idle: "10m" } } });
    const third = await call("PUT", manifests("pinned"), box("pinned", { lifecycle: { idle: "15m" } }));
    expect(third.body.warnings).toEqual([{ code: "agents_move", message: expect.stringContaining("1 at once") }]);
    expect((await call("GET", agents("pinned/one"))).body).toMatchObject({ resolvedVersion: 3, runtime: { lifecycle: { idle: "15m" } } });
    // Back to version 1, pinned, and another manifest is fixed for its life.
    expect((await call("PUT", agents("pinned/one"), { manifest: "pinned@1" })).body).toMatchObject({ resolvedVersion: 1, tracking: "pinned" });
    const other = await call("PUT", agents("pinned/one"), { manifest: "box" });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "agent_fixed_field", details: { fields: [{ field: "manifest", from: "pinned", to: "box" }] } });
    // A new Agent takes the latest, or the version it names, and says which.
    expect((await call("PUT", agents("pinned/two"), { manifest: "pinned" })).body.resolvedVersion).toBe(3);
    expect((await call("PUT", agents("pinned/three"), { manifest: "pinned@1" })).body).toMatchObject({
      manifest: "pinned@1",
      resolvedVersion: 1,
      tracking: "pinned",
    });
    expect((await call("GET", manifests("pinned", "/versions"))).body.versions.map((v: { agents: number }) => v.agents)).toEqual([1, 0, 2]);
    // The created event names it.
    const events = await call("GET", `${agents("pinned/one")}/events`);
    expect(events.body.events[0]).toMatchObject({
      type: "agent.created",
      agentId: "pinned/one",
      payload: { manifest: { name: "pinned", version: 1, tracking: "tracking" } },
    });
    // A session pins the version its Agent runs; no session was opened by making the Agent.
    expect((await open("pinned-s1", "pinned/two")).body).toMatchObject({ agentId: "pinned/two", manifest: { name: "pinned", version: 3 } });
    // Each move is on the Agent's stream.
    const moves = (await call("GET", `${agents("pinned/one")}/events?types=agent.version_changed`)).body.events;
    expect(moves.map((event: { payload: unknown }) => event.payload)).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 1 },
    ]);
  });

  it("refuses a missing manifest, a bad reference and inline fields", async () => {
    expect((await call("PUT", agents("strict/none"), { manifest: "nothing" })).body).toMatchObject({ code: "manifest_not_found" });
    expect((await call("PUT", agents("strict/bad"), { manifest: "box@0" })).status).toBe(400);
    expect((await call("PUT", agents("strict/inline"), { kind: "virtual" })).status).toBe(400);
    expect((await call("PUT", agents("strict/old"), { manifest: "box", ownerUserId: "x" })).status).toBe(400);
  });

  it("lists Agents by label, state and manifest", async () => {
    await call("PUT", manifests("listed"), box("listed"));
    await call("PUT", agents("listed/a"), { manifest: "listed", labels: { team: "x" } });
    await call("PUT", agents("listed/b"), { manifest: "listed", labels: { team: "y" } });
    const byManifest = await call("GET", "/v1/agents?manifest=listed");
    expect(byManifest.body.agents.map((agent: { id: string }) => agent.id)).toEqual(["listed/a", "listed/b"]);
    const byLabel = await call("GET", "/v1/agents?manifest=listed&label=team=y");
    expect(byLabel.body.agents.map((agent: { id: string }) => agent.id)).toEqual(["listed/b"]);
    expect((await call("GET", "/v1/agents?manifest=listed&state=input_required")).body.agents).toEqual([]);
    expect((await call("GET", "/v1/agents?manifest=listed&state=sleeping")).body.agents).toHaveLength(2);
    expect((await call("GET", "/v1/agents?state=bored")).status).toBe(400);
    const page = await call("GET", "/v1/agents?manifest=listed&limit=1");
    expect(page.body.agents.map((agent: { id: string }) => agent.id)).toEqual(["listed/a"]);
    const next = await call("GET", `/v1/agents?manifest=listed&limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body).toMatchObject({ agents: [{ id: "listed/b" }], nextCursor: null });
  });

  it("refuses to delete a manifest an Agent was made from", async () => {
    await call("PUT", manifests("held"), box("held"));
    await call("PUT", agents("held/one"), { manifest: "held" });
    const refused = await call("DELETE", manifests("held"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "manifest_in_use", details: { agents: 1 } });
    expect((await call("DELETE", agents("held/one"))).status).toBe(200);
    expect((await call("DELETE", manifests("held"))).body).toEqual({ name: "held", deleted: true });
    expect((await call("DELETE", manifests("held"))).body).toEqual({ name: "held", deleted: false });
  });
});

describe("secret slots", () => {
  it("takes a slot's value only, binds it from the slot, and refuses a name it does not declare", async () => {
    await call(
      "PUT",
      manifests("slotted"),
      box("slotted", {
        secrets: {
          GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"], required: true, description: "Reads repos" },
          MODE: { type: "environment_variable" },
        },
      }),
    );
    const made = await call("PUT", agents("slotted/one"), { manifest: "slotted" });
    expect(made.body.slots).toEqual([
      { name: "GH_TOKEN", type: "environment_secret", required: true, set: false },
      { name: "MODE", type: "environment_variable", required: false, set: false },
    ]);
    const written = await call("PUT", `${agents("slotted/one")}/secrets/GH_TOKEN`, { value: "ghp_example" });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ name: "GH_TOKEN", type: "environment_secret", binding: { allowedHosts: ["api.github.com"] } });
    expect((await call("PUT", `${agents("slotted/one")}/secrets/MODE`, { value: "fast" })).status).toBe(200);
    expect((await call("GET", agents("slotted/one"))).body.slots.every((slot: { set: boolean }) => slot.set)).toBe(true);
    const undeclared = await call("PUT", `${agents("slotted/one")}/secrets/OTHER`, { value: "x" });
    expect(undeclared.status).toBe(409);
    expect(undeclared.body).toMatchObject({ code: "secret_not_in_manifest", details: { declared: ["GH_TOKEN", "MODE"] } });
    // A full body is accepted only with the slot's own binding.
    expect(
      (await call("PUT", `${agents("slotted/one")}/secrets/GH_TOKEN`, {
        type: "environment_secret",
        value: "ghp_rotated",
        allowedHosts: ["api.github.com"],
      })).status,
    ).toBe(200);
    const widened = await call("PUT", `${agents("slotted/one")}/secrets/GH_TOKEN`, {
      type: "environment_secret",
      value: "ghp_rotated",
      allowedHosts: ["api.github.com", "evil.example.com"],
    });
    expect(widened.status).toBe(409);
    expect(widened.body.code).toBe("secret_not_in_manifest");
  });

  it("keeps today's typed writes on an Agent whose manifest declares no slots", async () => {
    await call("PUT", agents("slotless/one"), { manifest: "box" });
    expect(
      (await call("PUT", `${agents("slotless/one")}/secrets/ANY`, { type: "environment_variable", value: "x" })).status,
    ).toBe(200);
  });
});

describe("forking", { timeout: 60_000 }, () => {
  const fork = (id: string, body: Record<string, unknown>) => call("POST", `${agents(id)}/fork`, body);
  const sessionOn = async (id: string, agent: string) => {
    const reply = await open(id, agent);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return id;
  };
  const write = (sessionId: string, file: string, content: string) =>
    call("POST", `/v1/sessions/${sessionId}/sandbox/write`, { path: file, content });
  const read = async (sessionId: string, file: string) =>
    JSON.stringify((await call("POST", `/v1/sessions/${sessionId}/sandbox/read`, { path: file })).body);

  it("makes a new Agent on the latest version, with the disk and the secrets, and leaves the source as it was", async () => {
    const slots = {
      GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"], required: true },
      OLD: { type: "environment_variable" },
    };
    expect((await call("PUT", manifests("forked"), box("forked", { secrets: slots }))).status).toBe(200);
    expect((await call("PUT", agents("forks/v1"), { manifest: "forked" })).status).toBe(200);
    await call("PUT", `${agents("forks/v1")}/secrets/GH_TOKEN`, { value: "ghp_example" });
    await call("PUT", `${agents("forks/v1")}/secrets/OLD`, { value: "kept-behind" });
    const s = await sessionOn("fork-src", "forks/v1");
    expect((await write(s, "notes.txt", "from v1\n")).status).toBe(200);

    // v2 widens the hosts, adds a required slot and drops OLD.
    const v2 = box("forked", {
      network: { allowedHosts: ["api.github.com", "pypi.org"] },
      secrets: { GH_TOKEN: slots.GH_TOKEN, PYPI: { type: "environment_secret", allowedHosts: ["pypi.org"], required: true } },
    });
    expect((await call("PUT", manifests("forked"), v2)).body.manifest.version).toBe(2);
    // Saving v2 changed nothing in v1's Agent.
    expect((await call("GET", agents("forks/v1"))).body).toMatchObject({ manifest: "forked", resolvedVersion: 1 });

    const plan = await fork("forks/v1", { id: "forks/v2", dryRun: true });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toEqual({
      dryRun: true,
      plan: {
        source: "forks/v1",
        id: "forks/v2",
        kind: "virtual",
        manifest: { name: "forked", version: 2 },
        disk: "latest",
        setup: false,
        secrets: { copied: ["GH_TOKEN"], dropped: ["OLD"], missing: ["PYPI"] },
        changes: expect.arrayContaining([
          expect.objectContaining({ path: "network.allowedHosts" }),
          expect.objectContaining({ path: "secrets.OLD" }),
          expect.objectContaining({ path: "secrets.PYPI" }),
        ]),
        sessions: 1,
        memories: 0,
      },
    });
    expect((await call("GET", agents("forks/v2"))).status).toBe(404);

    const made = await fork("forks/v1", { id: "forks/v2", labels: { stage: "next" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.plan).toMatchObject({ disk: 1, secrets: { copied: ["GH_TOKEN"], dropped: ["OLD"], missing: ["PYPI"] } });
    expect(made.body.agent).toMatchObject({
      id: "forks/v2",
      labels: { stage: "next" },
      manifest: "forked",
      resolvedVersion: 2,
      tracking: "tracking",
      forkedFrom: { agent: "forks/v1", disk: 1 },
      slots: [
        { name: "GH_TOKEN", type: "environment_secret", required: true, set: true },
        { name: "PYPI", type: "environment_secret", required: true, set: false },
      ],
    });
    const copied = await call("GET", `${agents("forks/v2")}/secrets/GH_TOKEN`);
    expect(copied.body).toMatchObject({ type: "environment_secret", binding: { allowedHosts: ["api.github.com"] } });
    const s2 = await sessionOn("fork-dst", "forks/v2");
    expect(await read(s2, "notes.txt")).toContain("from v1");
    // The fork diverges; the source keeps what it runs, its disk and its session.
    await write(s2, "notes.txt", "from v2\n");
    expect(await read(s, "notes.txt")).toContain("from v1");
    expect((await call("GET", agents("forks/v1"))).body).toMatchObject({
      resolvedVersion: 1,
      sessions: [expect.objectContaining({ id: "fork-src" })],
    });
    const events = await call("GET", `${agents("forks/v1")}/events`);
    expect(JSON.stringify(events.body)).toContain("agent.forked");
    // The fork's id is new: a second fork onto it is refused.
    expect((await fork("forks/v1", { id: "forks/v2" })).status).toBe(409);
  });

  it("starts an empty disk, copies no secrets, takes a named version, and refuses what it cannot fork", async () => {
    const made = await fork("forks/v1", { id: "forks/bare", manifest: "forked@1", disk: "empty", secrets: "none" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.agent).toMatchObject({ manifest: "forked@1", resolvedVersion: 1, tracking: "pinned", forkedFrom: { agent: "forks/v1", disk: null } });
    expect(made.body.plan.secrets).toEqual({ copied: [], dropped: ["GH_TOKEN", "OLD"], missing: ["GH_TOKEN"] });
    const s = await sessionOn("fork-bare", "forks/bare");
    expect(await read(s, "notes.txt")).toContain("sandbox.not_found");
    expect((await fork("forks/v1", { id: "forks/v1" })).status).toBe(400);
    expect((await fork("forks/v1", { id: "forks/x", manifest: "forked@9" })).body.code).toBe("manifest_not_found");
    expect((await fork("forks/v1", { id: "forks/x", disk: 99 })).status).toBe(404);
    expect((await fork("forks/missing", { id: "forks/x" })).status).toBe(404);
  });
});
