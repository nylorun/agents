import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { stackPaths } from "../../src/stack/paths.js";
import { environmentsCommand } from "../../src/client/environments.js";
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
  manifest: { harness: "nylorun", lifecycle: {} },
  version: 1,
  appliedVersion: 1,
  ownerUserId: null,
  lastUsedAt: "2026-10-03T00:00:00.000Z",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};
const ENVIRONMENTS = [
  {
    ...view,
    id: "team-a/proj-42",
    kind: "virtual",
    labels: { project: "acme" },
    manifestName: "box",
    manifestVersion: 1,
    state: "running",
    sessions: [{ id: "s1", activeTurnId: null }],
  },
  { ...view, id: "user-7", kind: "pod", labels: {}, state: "stopped", sessions: [] },
];

/** A running Tenant whose Runtime answers the Environment routes. */
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
    if (path === "/v1/environments") return json({ environments: ENVIRONMENTS });
    if (path === "/v1/environment-manifests")
      return json({ manifests: [{ name: "box", version: 2, manifest: { kind: "virtual" }, environments: 1, savedBy: { actor: "cli" } }] });
    if (path.startsWith("/v1/files/")) return init?.method === "HEAD" ? new Response(null, { status: 404 }) : json({}, 201);
    if (path === "/v1/environment-manifests/box" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (new URL(url).searchParams.get("dryRun") === "true")
        return json({ name: "box", from: 2, to: 3, unchanged: false, changes: [], warnings: [], errors: body.image === "bad" ? ["image"] : [], behind: 1 });
      return json({ manifest: { name: "box", version: 3 }, unchanged: false, warnings: [] });
    }
    if (path === "/v1/environments/team-a%2Fproj-42/fork") {
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
      return json(body.dryRun ? { dryRun: true, plan } : { environment: { ...view, id: body.id }, plan }, body.dryRun ? 200 : 201);
    }
    if (path === "/v1/environments/team-a%2Fproj-42/secrets/GH_TOKEN") return json({ name: "GH_TOKEN" });
    if (path === "/v1/environments/team-a%2Fproj-42" && init?.method === "DELETE")
      return json({ id: "team-a/proj-42", deleted: true });
    if (path.startsWith("/v1/environments/") && init?.method === "DELETE")
      return json({ id: "x", deleted: false });
    return undefined;
  });
  const deps = testDeps(home, { docker, fetch });
  await runStackCommand("start", ["--no-open"], deps);
  deps.lines.length = 0;
  deps.errors.length = 0;
  docker.streamed.length = 0;
  return { home, deps, fetch, docker, keys };
}

describe("nylorun environments", () => {
  it("ls lists the Tenant's Environments with the application key cli, put once and kept in the Host root", async () => {
    const { home, deps, fetch, docker, keys } = await running();
    expect(await environmentsCommand(deps, ["list", "--label", "project=acme"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID              KIND     MANIFEST  STATE    SESSIONS  LABELS",
      "team-a/proj-42  virtual  box@1     running  1         project=acme",
      "user-7          pod      -         stopped  0         -",
    ]);
    const request = fetch.requests.find((item) => item.url.includes("/v1/environments"))!;
    // The SDK checks the Runtime's protocol once, before its first request.
    expect(fetch.requests.filter((item) => item.url.endsWith("/health")).length).toBeGreaterThan(0);
    expect(new URL(request.url).searchParams.getAll("label")).toEqual(["project=acme"]);
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
    expect(await environmentsCommand(deps, ["list"])).toBe(0);
    expect(docker.calls.filter((args) => args.includes("keys"))).toHaveLength(2);
  });

  it("ls --json prints the Environments", async () => {
    const { deps } = await running();
    expect(await environmentsCommand(deps, ["list", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toEqual(ENVIRONMENTS);
  });

  it("rm deletes an Environment by an id with slashes, and says when there is none", async () => {
    const { deps, fetch } = await running();
    expect(await environmentsCommand(deps, ["delete", "team-a/proj-42"])).toBe(0);
    expect(deps.lines).toEqual(["Deleted Environment team-a/proj-42: its sandbox, files and vault."]);
    const request = fetch.requests.find((item) => item.init?.method === "DELETE")!;
    expect(new URL(request.url).pathname).toBe("/v1/environments/team-a%2Fproj-42");
    expect(await environmentsCommand(deps, ["delete", "ghost"])).toBe(1);
    expect(deps.errors).toEqual(["No Environment ghost on Tenant home-root."]);
  });

  it("lists the Environments behind their manifest's latest version", async () => {
    const { deps } = await running();
    expect(await environmentsCommand(deps, ["list", "--behind"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID              KIND     MANIFEST  STATE    SESSIONS  LABELS",
      "team-a/proj-42  virtual  box@1     running  1         project=acme",
    ]);
  });

  it("forks an Environment, plans a fork, and says which slots to set", async () => {
    const { deps, fetch } = await running();
    expect(
      await environmentsCommand(deps, ["fork", "team-a/proj-42", "team-a/proj-43", "--manifest", "box@2", "--disk", "empty", "--secrets", "none", "--dry-run"]),
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
    expect(await environmentsCommand(deps, ["fork", "team-a/proj-42", "team-a/proj-43"])).toBe(0);
    expect(deps.errors).toEqual([
      "Forked Environment team-a/proj-42 into team-a/proj-43 on Tenant home-root: box@2, disk version 4, 1 secrets copied.",
      "  set before use: PYPI (nylorun environments secrets put team-a/proj-43 <name>)",
    ]);
    await expect(environmentsCommand(deps, ["fork", "team-a/proj-42", "x", "--disk", "soon"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("saves a manifest with a folder of files by hash, and fails a dry run the Runtime would refuse", async () => {
    const { home, deps, fetch } = await running();
    const dir = join(home, "envs");
    mkdirSync(join(dir, "kit", "bin"), { recursive: true });
    writeFileSync(join(dir, "kit", "bin", "run.sh"), "echo kit\n");
    writeFileSync(
      join(dir, "box.json"),
      JSON.stringify({ $schema: "https://docs.nylorun.com/schemas/environment-manifest/v1.json", name: "box", kind: "pod", files: [{ path: "/workspace/kit", from: "kit" }] }),
    );
    expect(await environmentsCommand(deps, ["manifests", "save", join(dir, "box.json"), "--if-match", "2"])).toBe(0);
    const uploads = fetch.requests.filter((item) => item.url.includes("/v1/files/") && item.init?.method === "PUT");
    expect(uploads).toHaveLength(1);
    const saved = fetch.requests.find((item) => item.url.endsWith("/v1/environment-manifests/box"))!;
    const body = JSON.parse(String(saved.init!.body));
    expect(body.$schema).toBeUndefined();
    expect(body.files).toEqual([{ path: "/workspace/kit", files: { "bin/run.sh": expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } }]);
    expect(new Headers(saved.init!.headers).get("if-match")).toBe("2");
    expect(deps.errors).toContain("Saved environment manifest box version 3 on Tenant home-root.");

    writeFileSync(join(dir, "bad.json"), JSON.stringify({ name: "box", image: "bad" }));
    expect(await environmentsCommand(deps, ["manifests", "save", join(dir, "bad.json"), "--dry-run"])).toBe(1);
  });

  it("puts from a manifest, and writes a slot's value from standard input", async () => {
    const { deps, fetch } = await running();
    await expect(environmentsCommand(deps, ["put", "a", "--manifest", "box", "--kind", "pod"])).rejects.toMatchObject({ exitCode: 2 });
    const piped = { ...deps, stdin: { isTTY: false, text: async () => "ghp_example\n" } };
    expect(await environmentsCommand(piped, ["secrets", "put", "team-a/proj-42", "GH_TOKEN"])).toBe(0);
    const written = fetch.requests.find((item) => item.url.endsWith("/secrets/GH_TOKEN"))!;
    expect(JSON.parse(String(written.init!.body))).toMatchObject({ value: "ghp_example" });
  });

  it("never starts a stopped Tenant", async () => {
    const { deps, docker } = await running({ up: false });
    await expect(environmentsCommand(deps, ["list"])).rejects.toMatchObject({ exitCode: 3 });
    expect(docker.streamed).toEqual([]);
  });

  it("checks its arguments", async () => {
    const { deps } = await running();
    await expect(environmentsCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(environmentsCommand(deps, ["delete"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(environmentsCommand(deps, ["list", "--label", "nokey"])).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
