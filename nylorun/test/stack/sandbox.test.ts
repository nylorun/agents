import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { stackPaths } from "../../src/stack/paths.js";
import { sandboxCommand } from "../../src/stack/sandbox.js";
import { deriveTenantKey, PROJECT_PRINCIPAL_ID } from "../../src/project/derived-key.js";
import { fakeDocker, fakeFetch, json, temporaryHome, testDeps } from "./support.js";

const TENANT_ID = "tn_01TESTSTACK000000000000001";

const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;
const adminKey = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).credentials, "utf8")) as { adminKey: string })
    .adminKey;

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

const SANDBOXES = [
  {
    id: "team-a/proj-42",
    kind: "virtual",
    labels: { project: "acme" },
    spec: {},
    state: "running",
    sessions: [{ id: "s1", activeTurnId: null }],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  },
  {
    id: "user-7",
    kind: "virtual",
    labels: {},
    spec: {},
    state: "ready",
    sessions: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  },
];

/** A running Tenant whose Runtime answers the sandbox routes. */
async function running(options: { up?: boolean } = {}) {
  const home = await temporaryHome();
  const docker = fakeDocker({
    respond: (args) => (options.up !== false && args.includes("ps") ? psUp : undefined),
  });
  const fetch = fakeFetch((url, init) => {
    if (url.endsWith("/health"))
      return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/v1/admin/status"))
      return json({ tenant: { id: TENANT_ID, name: "home-root", state: "open", envelope: null } });
    if (url.endsWith("/_studio/login-tokens")) return json({ token: "t" }, 201);
    const path = new URL(url).pathname;
    if (path === "/v1/sandboxes") return json({ sandboxes: SANDBOXES });
    if (path === "/v1/sandboxes/team-a%2Fproj-42" && init?.method === "DELETE")
      return json({ id: "team-a/proj-42", deleted: true });
    if (path.startsWith("/v1/sandboxes/") && init?.method === "DELETE")
      return json({ id: "x", deleted: false });
    return undefined;
  });
  const deps = testDeps(home, { docker, fetch });
  await runStackCommand("start", ["--no-open"], deps);
  deps.lines.length = 0;
  deps.errors.length = 0;
  docker.streamed.length = 0;
  return { home, deps, fetch, docker };
}

describe("nylorun sandbox", () => {
  it("ls lists the Tenant's sandboxes as the Project principal", async () => {
    const { home, deps, fetch } = await running();
    expect(await sandboxCommand(deps, ["ls", "--label", "project=acme"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID              KIND     STATE    SESSIONS  LABELS",
      "team-a/proj-42  virtual  running  1         project=acme",
      "user-7          virtual  ready    0         -",
    ]);
    const request = fetch.requests.find((item) => item.url.includes("/v1/sandboxes"))!;
    expect(new URL(request.url).searchParams.getAll("label")).toEqual(["project=acme"]);
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${deriveTenantKey(adminKey(home), TENANT_ID, PROJECT_PRINCIPAL_ID)}`,
    );
    expect(headers.get("nylorun-protocol")).toBe("6");
  });

  it("ls --json prints the sandboxes", async () => {
    const { deps } = await running();
    expect(await sandboxCommand(deps, ["ls", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toEqual(SANDBOXES);
  });

  it("rm deletes a sandbox by an id with slashes, and says when there is none", async () => {
    const { deps, fetch } = await running();
    expect(await sandboxCommand(deps, ["rm", "team-a/proj-42"])).toBe(0);
    expect(deps.lines).toEqual(["Deleted sandbox team-a/proj-42 and its files."]);
    const request = fetch.requests.find((item) => item.init?.method === "DELETE")!;
    expect(new URL(request.url).pathname).toBe("/v1/sandboxes/team-a%2Fproj-42");
    expect(await sandboxCommand(deps, ["rm", "ghost"])).toBe(1);
    expect(deps.errors).toEqual(["No sandbox ghost on Tenant home-root."]);
  });

  it("never starts a stopped Tenant", async () => {
    const { deps, docker } = await running({ up: false });
    await expect(sandboxCommand(deps, ["ls"])).rejects.toMatchObject({ exitCode: 3 });
    expect(docker.streamed).toEqual([]);
  });

  it("checks its arguments", async () => {
    const { deps } = await running();
    await expect(sandboxCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(sandboxCommand(deps, ["rm"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(sandboxCommand(deps, ["ls", "--label", "nokey"])).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
