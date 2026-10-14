/**
 * Environment manifests (protocol 14, D63 to D65): versions saved like agents, with `If-Match`
 * and a dry-run plan; Environments made from one version and never changed by a save; secret
 * slots, written by value; an agent's `requires`, checked when a session opens; and the agent
 * save's dry run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

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

const manifests = (name: string, rest = "") => `/v1/environment-manifests/${name}${rest}`;
const environments = (id: string) => `/v1/environments/${encodeURIComponent(id)}`;
const box = (extra: Record<string, unknown> = {}) => ({
  manifestSchemaVersion: 1,
  name: "box",
  network: { allowedHosts: ["api.github.com"] },
  ...extra,
});

async function register(agent: { manifest: unknown; id: string }, query = ""): Promise<Reply> {
  return call("PUT", `/v1/agents/${agent.id}${query}`, {
    requestId: `save-${agent.id}${query}`,
    manifest: agent.manifest,
    implementationVersion: "dev",
  });
}

function open(id: string, agentId: string, environment?: string): Promise<Reply> {
  return call("PUT", `/v1/sessions/${id}`, {
    requestId: `open-${id}`,
    agentId,
    ownerUserId: "app:ada",
    ...(environment === undefined ? {} : { environment }),
  });
}

beforeAll(async () => {
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    sandbox: { backend: "virtual" },
  });
  expect((await register(Agent({ id: "bot", name: "Bot" }).instructions("Work.").build())).status).toBe(200);
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
      manifest: { name: "box", version: 1, savedBy: { actor: "application" }, environments: 0 },
    });
    expect(first.body.manifest.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await call("PUT", manifests("box"), box());
    expect(again.body).toMatchObject({ unchanged: true, manifest: { version: 1, hash: first.body.manifest.hash } });
    const second = await call("PUT", manifests("box"), box({ description: "With a description" }));
    expect(second.body).toMatchObject({ unchanged: false, manifest: { version: 2 } });
    expect((await call("GET", manifests("box"))).body).toMatchObject({ version: 2, manifest: { description: "With a description" } });
    expect((await call("GET", manifests("box", "/versions/1"))).body.manifest.description).toBeUndefined();
    const versions = await call("GET", manifests("box", "/versions"));
    expect(versions.body).toMatchObject({ name: "box", latest: 2 });
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await call("GET", "/v1/environment-manifests")).body.manifests.map((m: { name: string }) => m.name)).toContain("box");
    expect((await call("GET", manifests("box", "/versions/9"))).body).toMatchObject({ code: "manifest_not_found" });
    expect((await call("GET", manifests("missing"))).status).toBe(404);
  });

  it("refuses a manifest whose name is not the path's, or a version it does not know", async () => {
    expect((await call("PUT", manifests("other"), box())).status).toBe(400);
    const version = await call("PUT", manifests("box"), { ...box(), manifestSchemaVersion: 2 });
    expect(version.status).toBe(400);
    expect(JSON.stringify(version.body)).toContain("manifestSchemaVersion");
    expect((await call("PUT", manifests("box"), { ...box(), $schema: "x" })).status).toBe(400);
  });

  it("refuses a save over a version the saver has not read (If-Match)", async () => {
    expect((await call("PUT", manifests("gated"), box({ name: "gated" }), { "if-match": "0" })).status).toBe(200);
    const stale = await call("PUT", manifests("gated"), box({ name: "gated", description: "x" }), { "if-match": "0" });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: "manifest_changed", details: { latest: 1 } });
    expect((await call("PUT", manifests("gated"), box({ name: "gated", description: "x" }), { "if-match": "1" })).body.manifest.version).toBe(2);
    expect((await call("PUT", manifests("fresh"), box({ name: "fresh" }), { "if-match": "3" })).status).toBe(412);
  });

  it("plans a save with dryRun: changes, errors, warnings and the Environments behind", async () => {
    await call("PUT", manifests("planned"), box({ name: "planned" }));
    expect((await call("PUT", environments("planned/one"), { manifest: "planned" })).status).toBe(200);
    const plan = await call(
      "PUT",
      `${manifests("planned")}?dryRun=true`,
      box({ name: "planned", network: { allowedHosts: ["api.github.com", "pypi.org"] }, kind: "pod", image: "python:3.13-slim" }),
    );
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ name: "planned", from: 1, to: 2, unchanged: false, errors: [], behind: 1 });
    expect(plan.body.changes.map((change: { path: string }) => change.path)).toEqual(["image", "kind", "network.allowedHosts"]);
    expect(plan.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(["image_tag", "pods_unavailable"]);
    // Nothing was saved.
    expect((await call("GET", manifests("planned"))).body.version).toBe(1);
    const tooBig = box({ name: "planned", resources: { cpus: 64 } });
    const refused = await call("PUT", `${manifests("planned")}?dryRun=true`, tooBig);
    expect(refused.body.errors.join(" ")).toContain("resources.cpus");
    expect((await call("PUT", manifests("planned"), tooBig)).status).toBe(400);
  });
});

describe("Environments made from a manifest", () => {
  it("pins the version it was made from: a later save changes nothing in it", async () => {
    await call("PUT", manifests("pinned"), box({ name: "pinned", lifecycle: { idle: "5m" } }));
    const made = await call("PUT", environments("pinned/one"), { manifest: "pinned", labels: { team: "a" } });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({
      kind: "virtual",
      manifestName: "pinned",
      manifestVersion: 1,
      labels: { team: "a" },
      manifest: { network: { allowedHosts: ["api.github.com"] }, lifecycle: { idle: "5m" } },
    });
    expect((await call("PUT", manifests("pinned"), box({ name: "pinned", lifecycle: { idle: "10m" } }))).body.manifest.version).toBe(2);
    // The Environment keeps version 1; a bare name still matches it, and labels still change.
    const again = await call("PUT", environments("pinned/one"), { manifest: "pinned", labels: { team: "b" } });
    expect(again.body).toMatchObject({ manifestVersion: 1, manifest: { lifecycle: { idle: "5m" } }, labels: { team: "b" } });
    const moved = await call("PUT", environments("pinned/one"), { manifest: "pinned@2" });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ code: "environment_immutable", details: { fields: ["manifest"], manifest: "pinned@1" } });
    // A new Environment takes the latest, or the version it names.
    expect((await call("PUT", environments("pinned/two"), { manifest: "pinned" })).body.manifestVersion).toBe(2);
    expect((await call("PUT", environments("pinned/three"), { manifest: "pinned@1" })).body.manifestVersion).toBe(1);
    expect((await call("GET", manifests("pinned", "/versions"))).body.versions.map((v: { environments: number }) => v.environments)).toEqual([1, 2]);
    // The created event names it.
    const events = await call("GET", `${environments("pinned/one")}/events`);
    expect(events.body.events[0]).toMatchObject({ type: "environment.created", payload: { manifest: { name: "pinned", version: 1 } } });
  });

  it("refuses inline fields beside a manifest, an inline Environment's move to one, and a missing manifest", async () => {
    await call("PUT", manifests("strict"), box({ name: "strict" }));
    const mixed = await call("PUT", environments("strict/one"), { manifest: "strict", network: { allowedHosts: [] } });
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toContain("network");
    expect((await call("PUT", environments("strict/inline"), {})).status).toBe(200);
    expect((await call("PUT", environments("strict/inline"), { manifest: "strict" })).body.code).toBe("environment_immutable");
    expect((await call("PUT", environments("strict/none"), { manifest: "nothing" })).body).toMatchObject({ code: "manifest_not_found" });
    expect((await call("PUT", environments("strict/bad"), { manifest: "strict@0" })).status).toBe(400);
  });

  it("refuses to delete a manifest an Environment was made from", async () => {
    await call("PUT", manifests("held"), box({ name: "held" }));
    await call("PUT", environments("held/one"), { manifest: "held" });
    const refused = await call("DELETE", manifests("held"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "manifest_in_use", details: { environments: 1 } });
    expect((await call("DELETE", environments("held/one"))).status).toBe(200);
    expect((await call("DELETE", manifests("held"))).body).toEqual({ name: "held", deleted: true });
    expect((await call("DELETE", manifests("held"))).body).toEqual({ name: "held", deleted: false });
  });
});

describe("secret slots", () => {
  it("takes a slot's value only, binds it from the slot, and refuses a name it does not declare", async () => {
    await call(
      "PUT",
      manifests("slotted"),
      box({
        name: "slotted",
        secrets: {
          GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"], required: true, description: "Reads repos" },
          MODE: { type: "environment_variable" },
        },
      }),
    );
    const made = await call("PUT", environments("slotted/one"), { manifest: "slotted" });
    expect(made.body.slots).toEqual([
      { name: "GH_TOKEN", type: "environment_secret", required: true, set: false },
      { name: "MODE", type: "environment_variable", required: false, set: false },
    ]);
    const written = await call("PUT", `${environments("slotted/one")}/secrets/GH_TOKEN`, { value: "ghp_example" });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ name: "GH_TOKEN", type: "environment_secret", binding: { allowedHosts: ["api.github.com"] } });
    expect((await call("PUT", `${environments("slotted/one")}/secrets/MODE`, { value: "fast" })).status).toBe(200);
    expect((await call("GET", environments("slotted/one"))).body.slots.every((slot: { set: boolean }) => slot.set)).toBe(true);
    const undeclared = await call("PUT", `${environments("slotted/one")}/secrets/OTHER`, { value: "x" });
    expect(undeclared.status).toBe(409);
    expect(undeclared.body).toMatchObject({ code: "secret_not_in_manifest", details: { declared: ["GH_TOKEN", "MODE"] } });
    // A full body is accepted only with the slot's own binding.
    expect(
      (await call("PUT", `${environments("slotted/one")}/secrets/GH_TOKEN`, {
        type: "environment_secret",
        value: "ghp_rotated",
        allowedHosts: ["api.github.com"],
      })).status,
    ).toBe(200);
    const widened = await call("PUT", `${environments("slotted/one")}/secrets/GH_TOKEN`, {
      type: "environment_secret",
      value: "ghp_rotated",
      allowedHosts: ["api.github.com", "evil.example.com"],
    });
    expect(widened.status).toBe(409);
    expect(widened.body.code).toBe("secret_not_in_manifest");
  });

  it("keeps today's typed writes on an Environment with no slots", async () => {
    await call("PUT", environments("slotless/one"), {});
    expect(
      (await call("PUT", `${environments("slotless/one")}/secrets/ANY`, { type: "environment_variable", value: "x" })).status,
    ).toBe(200);
  });
});

describe("requires", () => {
  it("refuses a session whose Environment lacks what the agent requires, naming each gap", async () => {
    const needy = Agent({ id: "needy", name: "Needy" })
      .instructions("Push to GitHub.")
      .requires({ sandbox: "any", secrets: ["GH_TOKEN"] })
      .build();
    expect(needy.manifest.requires).toEqual({ sandbox: "any", secrets: ["GH_TOKEN"] });
    expect((await register(needy)).status).toBe(200);
    const bare = await open("needy-bare", "needy");
    expect(bare.status).toBe(409);
    expect(bare.body).toMatchObject({ code: "environment_unsuitable", details: { missing: ["sandbox", "secret:GH_TOKEN"] } });
    await call("PUT", environments("needy/ws"), {});
    expect((await open("needy-ws", "needy", "needy/ws")).body.details.missing).toEqual(["secret:GH_TOKEN"]);
    await call("PUT", `${environments("needy/ws")}/secrets/GH_TOKEN`, {
      type: "environment_secret",
      value: "ghp_example",
      allowedHosts: ["api.github.com"],
    });
    expect((await open("needy-ws2", "needy", "needy/ws")).status).toBe(200);
    const podOnly = Agent({ id: "pod-only", name: "Pod only" }).instructions("Build.").requires({ sandbox: "pod" }).build();
    await register(podOnly);
    expect((await open("pod-only-ws", "pod-only", "needy/ws")).body.details.missing).toEqual(["pod"]);
  });
});

describe("the agent save's dry run", () => {
  it("checks a definition and saves nothing", async () => {
    const draft = Agent({ id: "draft", name: "Draft" }).instructions("Draft.").build();
    const checked = await register(draft, "?dryRun=true");
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ agentId: "draft", dryRun: true });
    expect((await open("draft-1", "draft")).status).toBe(404);
    expect((await register(draft)).body.dryRun).toBeUndefined();
    expect((await open("draft-2", "draft")).status).toBe(200);
  });
});
