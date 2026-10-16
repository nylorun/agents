import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { stackPaths } from "../../src/stack/paths.js";
import { agentManifestsCommand } from "../../src/client/agent-manifests.js";
import { agentsCommand } from "../../src/client/agents.js";
import {
  bearerIn,
  fakeDocker,
  fakeFetch,
  fakeOperate,
  json,
  temporaryHome,
  testDeps,
  readyResponse,
  type FakeKeys,
} from "../stack/support.js";

const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;

const psUp = {
  code: 0,
  stdout: JSON.stringify([
    { Service: "gateway", State: "running", Health: "healthy" },
    { Service: "runtime", State: "running", Health: "healthy" },
    { Service: "harness", State: "running", Health: "healthy" },
    { Service: "studio", State: "running", Health: "healthy" },
  ]),
  stderr: "",
};

const view = {
  manifestHash: "h",
  harness: "nylorun",
  attention: [],
  desired: "on",
  compute: { state: "ready" },
  runtime: { harness: "nylorun", lifecycle: {} },
  limits: {
    artifacts: { fileBytes: 1, totalBytes: 1 },
    skills: { totalBytes: 1 },
    disk: { versionBytes: 1, versionEntries: 1 },
  },
  slots: [],
  forkedFrom: null,
  lastUsedAt: "2026-10-03T00:00:00.000Z",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};
const AGENTS = [
  {
    ...view,
    id: "team-a/proj-42",
    manifest: "box",
    resolvedVersion: 1,
    tracking: "tracking",
    kind: "virtual",
    owner: "alice",
    labels: { project: "acme" },
    state: "working",
    sessions: [{ id: "s1", ownerUserId: "alice", status: "running", activeTurnId: "t1" }],
  },
  {
    ...view,
    id: "user-7",
    manifest: "box@2",
    resolvedVersion: 2,
    tracking: "pinned",
    kind: "pod",
    owner: null,
    labels: {},
    state: "sleeping",
    sessions: [],
  },
];
const MANIFESTS = [
  {
    name: "box",
    version: 2,
    hash: "h2",
    manifest: { manifestSchemaVersion: 8, name: "box", harness: { instructions: ["Help."] }, runtime: { kind: "virtual" } },
    savedBy: { actor: "application" },
    createdAt: "2026-10-03T00:00:00.000Z",
    agents: 2,
  },
  {
    name: "desk",
    version: 1,
    hash: "h1",
    manifest: { manifestSchemaVersion: 8, name: "desk", harness: { kind: "workflow", root: {}, agents: {} } },
    savedBy: { actor: "application" },
    createdAt: "2026-10-03T00:00:00.000Z",
    agents: 0,
  },
];

/** A running Tenant whose Runtime answers the Agent and agent manifest routes. */
async function running(options: { up?: boolean } = {}) {
  const home = await temporaryHome();
  const keys: FakeKeys = new Map();
  const operate = fakeOperate(() => keys);
  const docker = fakeDocker({
    respond: (args) => (args.includes("ps") ? (options.up !== false ? psUp : undefined) : operate(args)),
  });
  const fetch = fakeFetch((url, init) => {
    if (url.endsWith("/health"))
      return json({
        status: "ok",
        version: "0.10.0-beta",
        hostId: hostId(home),
        protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] },
      });
    if (url.endsWith("/ready")) return readyResponse();
    if (url.endsWith("/_studio/login-tokens")) return json({ token: "t" }, 201);
    const path = new URL(url).pathname;
    if (path === "/v1/me")
      return bearerIn(keys.values(), init)
        ? json({ kind: "application" })
        : json({ status: "rejected", code: "not_found", message: "Not found" }, 404);
    if (path === "/v1/agents") return json({ agents: AGENTS });
    if (path === "/v1/agent-manifests") return json({ manifests: MANIFESTS });
    if (path === "/v1/agent-manifests/box" && init?.method === "DELETE")
      return json({ status: "rejected", code: "manifest_in_use", message: "Agents were made from it." }, 409);
    if (path === "/v1/agent-manifests/gone" && init?.method === "DELETE") return json({ name: "gone", deleted: false });
    if (path === "/v1/agent-manifests/box/versions/2") return json(MANIFESTS[0]);
    if (path === "/v1/agents/team-a%2Fproj-42/fork") {
      const body = JSON.parse(String(init!.body));
      const plan = {
        source: "team-a/proj-42",
        id: body.id,
        kind: "virtual",
        manifest: { name: "box", version: 2 },
        disk: body.dryRun ? "latest" : 4,
        setup: false,
        secrets: { copied: ["GH_TOKEN"], dropped: [], missing: ["PYPI"] },
        changes: [],
        sessions: 1,
      };
      return json(body.dryRun ? { dryRun: true, plan } : { agent: { ...AGENTS[0], id: body.id }, plan }, body.dryRun ? 200 : 201);
    }
    if (path === "/v1/agents/users%2Falice" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return json({ ...AGENTS[0], id: "users/alice", manifest: body.manifest, owner: body.owner ?? null, labels: body.labels ?? {} }, 201);
    }
    if (path === "/v1/agents/team-a%2Fproj-42/secrets/GH_TOKEN") return json({ name: "GH_TOKEN" });
    if (path === "/v1/agents/team-a%2Fproj-42" && init?.method === "DELETE")
      return json({ id: "team-a/proj-42", deleted: true });
    if (path.startsWith("/v1/agents/") && init?.method === "DELETE") return json({ id: "x", deleted: false });
    return undefined;
  });
  const deps = testDeps(home, { docker, fetch });
  await runStackCommand("start", ["--no-open"], deps);
  deps.lines.length = 0;
  deps.errors.length = 0;
  docker.streamed.length = 0;
  return { home, deps, fetch, docker, keys };
}

describe("nylorun agents", () => {
  it("list prints the Tenant's Agents with the application key cli, put once and kept in the Host root", async () => {
    const { home, deps, fetch, docker, keys } = await running();
    expect(await agentsCommand(deps, ["list", "--label", "project=acme", "--state", "working", "--manifest", "box"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID              MANIFEST      KIND     STATE     SESSIONS  OWNER  LABELS",
      "team-a/proj-42  box@1 tracks  virtual  working   1         alice  project=acme",
      "user-7          box@2 pinned  pod      sleeping  0         -      -",
    ]);
    const request = fetch.requests.find((item) => item.url.includes("/v1/agents"))!;
    // The SDK checks the Runtime's protocol once, before its first request.
    expect(fetch.requests.filter((item) => item.url.endsWith("/health")).length).toBeGreaterThan(0);
    const query = new URL(request.url).searchParams;
    expect(query.getAll("label")).toEqual(["project=acme"]);
    expect(query.get("state")).toBe("working");
    expect(query.get("manifest")).toBe("box");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${keys.get("cli")!.key}`);
    expect(headers.get("nylorun-protocol")).toBe(String(PROTOCOL_VERSION));
    const file = stackPaths(home).cliCredentials;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      format: 1,
      applicationKey: keys.get("cli")!.key,
      principalId: "cli",
      managementKey: keys.get("cli-management")!.key,
      managementPrincipalId: "cli-management",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A later command reuses the kept keys: no second put.
    expect(await agentsCommand(deps, ["list"])).toBe(0);
    expect(docker.calls.filter((args) => args.includes("keys"))).toHaveLength(2);
  });

  it("list --json prints the Agents, and --behind those on an older version than their manifest's latest", async () => {
    const { deps } = await running();
    expect(await agentsCommand(deps, ["list", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toEqual(AGENTS);
    deps.lines.length = 0;
    expect(await agentsCommand(deps, ["list", "--behind"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID              MANIFEST      KIND     STATE    SESSIONS  OWNER  LABELS",
      "team-a/proj-42  box@1 tracks  virtual  working  1         alice  project=acme",
    ]);
  });

  it("puts an Agent from a manifest, with its owner and labels", async () => {
    const { deps, fetch } = await running();
    expect(await agentsCommand(deps, ["put", "users/alice", "--manifest", "box@2", "--owner", "alice", "--label", "team=a"])).toBe(0);
    const put = fetch.requests.find((item) => item.init?.method === "PUT" && item.url.includes("/v1/agents/"))!;
    expect(new URL(put.url).pathname).toBe("/v1/agents/users%2Falice");
    expect(JSON.parse(String(put.init!.body))).toEqual({
      requestId: expect.any(String),
      manifest: "box@2",
      owner: "alice",
      labels: { team: "a" },
    });
    expect(deps.errors).toEqual(["Agent users/alice runs box@1 tracks on Tenant home-root."]);
    await expect(agentsCommand(deps, ["put", "a", "--manifest", "no/such"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("rm deletes an Agent by an id with slashes, and says when there is none", async () => {
    const { deps, fetch } = await running();
    expect(await agentsCommand(deps, ["rm", "team-a/proj-42"])).toBe(0);
    expect(deps.lines).toEqual(["Deleted Agent team-a/proj-42: its sandbox, files and vault."]);
    const request = fetch.requests.find((item) => item.init?.method === "DELETE")!;
    expect(new URL(request.url).pathname).toBe("/v1/agents/team-a%2Fproj-42");
    expect(await agentsCommand(deps, ["rm", "ghost"])).toBe(1);
    expect(deps.errors).toEqual(["No Agent ghost on Tenant home-root."]);
  });

  it("forks an Agent, plans a fork, and says which slots to set", async () => {
    const { deps, fetch } = await running();
    expect(
      await agentsCommand(deps, ["fork", "team-a/proj-42", "team-a/proj-43", "--manifest", "box@2", "--disk", "empty", "--secrets", "none", "--dry-run"]),
    ).toBe(0);
    const planned = fetch.requests.find((item) => item.url.endsWith("/fork"))!;
    expect(JSON.parse(String(planned.init!.body))).toEqual({
      id: "team-a/proj-43",
      manifest: "box@2",
      disk: "empty",
      secrets: "none",
      dryRun: true,
    });
    expect(JSON.parse(deps.lines.join("\n")).secrets.missing).toEqual(["PYPI"]);
    deps.lines.length = 0;
    expect(await agentsCommand(deps, ["fork", "team-a/proj-42", "team-a/proj-43"])).toBe(0);
    expect(deps.errors).toEqual([
      "Forked Agent team-a/proj-42 into team-a/proj-43 on Tenant home-root: box@2, disk version 4, 1 secrets copied.",
      "  set before use: PYPI (nylorun agents secrets put team-a/proj-43 <name>)",
    ]);
    await expect(agentsCommand(deps, ["fork", "team-a/proj-42", "x", "--disk", "soon"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("writes a slot's value from standard input", async () => {
    const { deps, fetch } = await running();
    const piped = { ...deps, stdin: { isTTY: false, text: async () => "ghp_example\n" } };
    expect(await agentsCommand(piped, ["secrets", "put", "team-a/proj-42", "GH_TOKEN"])).toBe(0);
    const written = fetch.requests.find((item) => item.url.endsWith("/secrets/GH_TOKEN"))!;
    expect(new URL(written.url).pathname).toBe("/v1/agents/team-a%2Fproj-42/secrets/GH_TOKEN");
    expect(JSON.parse(String(written.init!.body))).toMatchObject({ value: "ghp_example" });
  });

  it("never starts a stopped Tenant", async () => {
    const { deps, docker } = await running({ up: false });
    await expect(agentsCommand(deps, ["list"])).rejects.toMatchObject({ exitCode: 3 });
    expect(docker.streamed).toEqual([]);
  });

  it("checks its arguments", async () => {
    const { deps } = await running();
    await expect(agentsCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(agentsCommand(deps, ["rm"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(agentsCommand(deps, ["save", "agent.json"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(agentsCommand(deps, ["list", "--label", "nokey"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("nylorun agent-manifests", () => {
  it("list prints each manifest's latest version, kind, harness and Agents", async () => {
    const { deps } = await running();
    expect(await agentManifestsCommand(deps, ["list"])).toBe(0);
    expect(deps.lines).toEqual([
      "NAME  VERSION  KIND     HARNESS         AGENTS",
      "box   2        virtual  nylorun         2",
      "desk  1        none     nylorun (flow)  0",
    ]);
  });

  it("get reads a version by name@n, and rm says when a manifest is in use or gone", async () => {
    const { deps, fetch } = await running();
    expect(await agentManifestsCommand(deps, ["get", "box@2"])).toBe(0);
    expect(fetch.requests.some((item) => item.url.endsWith("/v1/agent-manifests/box/versions/2"))).toBe(true);
    expect(JSON.parse(deps.lines.join("\n"))).toMatchObject({ name: "box", version: 2 });
    await expect(agentManifestsCommand(deps, ["rm", "box"])).rejects.toThrow(/Agents were made from it \(manifest_in_use\)\. HTTP 409\./);
    expect(await agentManifestsCommand(deps, ["rm", "gone"])).toBe(1);
    expect(deps.errors).toEqual(["No agent manifest gone on Tenant home-root."]);
  });
});
