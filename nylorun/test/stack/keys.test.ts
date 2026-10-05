import { readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runningTenantApi, runStackCommand } from "../../src/stack/commands.js";
import { keyCommand } from "../../src/stack/keys.js";
import { stackPaths } from "../../src/stack/paths.js";
import {
  bearerIn,
  fakeDocker,
  fakeFetch,
  fakeOperate,
  json,
  temporaryDir,
  temporaryHome,
  testDeps,
  type FakeKeys,
} from "./support.js";

const TENANT_ID = "tn_01TESTSTACK000000000000001";

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

/** A running Tenant whose `nylorun-operate` keeps keys and whose `/v1/me` checks them. */
async function running(options: { project?: boolean } = {}) {
  const home = await temporaryHome();
  const keys: FakeKeys = new Map();
  const operate = fakeOperate(() => keys);
  const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : operate(args)) });
  const fetch = fakeFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path === "/health") {
      const { hostId } = JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string };
      return json({ status: "ok", version: "0.10.0-beta", hostId });
    }
    if (path === "/v1/admin/status")
      return json({ tenant: { id: TENANT_ID, name: "t", state: "open", envelope: null } });
    if (path === "/v1/me")
      return bearerIn(keys.values(), init)
        ? json({ kind: "application" })
        : json({ status: "rejected", code: "not_found", message: "Not found" }, 404);
    return undefined;
  });
  let cwd: string | undefined;
  if (options.project) {
    cwd = realpathSync(await temporaryDir("nylorun-keys-project-"));
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), "{}");
  }
  const deps = testDeps(home, { docker, fetch, ...(cwd ? { cwd } : {}) });
  expect(await runStackCommand("start", ["--no-open", "--no-studio"], deps)).toBe(0);
  deps.lines.length = 0;
  deps.errors.length = 0;
  fetch.requests.length = 0;
  docker.calls.length = 0;
  return { home, deps, fetch, docker, keys, cwd };
}

/** The `nylorun-operate` arguments of each run in the runtime container. */
const operated = (docker: { calls: string[][] }) =>
  docker.calls
    .filter((args) => args.includes("nylorun-operate"))
    .map((args) => args.slice(args.indexOf("exec")).join(" "));

describe("nylorun key", () => {
  it("put prints the key once, list shows ids and roles without keys, rm deletes", async () => {
    const { deps, keys, docker } = await running();
    expect(await keyCommand(deps, ["put", "backend"])).toBe(0);
    expect(deps.lines).toEqual([keys.get("backend")!.key]);
    expect(deps.errors).toEqual([
      "Created application key backend on Tenant home-root. Store it now: it is not shown again.",
    ]);
    // Through nylorun-operate in the runtime container, not the Admin API.
    expect(operated(docker)).toEqual([
      "exec -T runtime nylorun-operate keys put backend --role application --json",
    ]);

    deps.lines.length = 0;
    deps.errors.length = 0;
    expect(await keyCommand(deps, ["put", "backend"])).toBe(0);
    expect(deps.errors[0]).toMatch(/^Rotated application key backend on Tenant home-root \(the previous key no longer works\)/);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["list"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID       ROLE         CREATED",
      "backend  application  2026-10-04T00:00:00.000Z",
    ]);
    expect(deps.lines.join("\n")).not.toContain(keys.get("backend")!.key);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["list", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toEqual([
      { id: "backend", role: "application", createdAt: "2026-10-04T00:00:00.000Z" },
    ]);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["rm", "backend"])).toBe(0);
    expect(deps.lines).toEqual(["Deleted key backend: it no longer works."]);
    expect(await keyCommand(deps, ["rm", "backend"])).toBe(1);
    expect(deps.errors.at(-1)).toBe("No key backend on Tenant home-root.");
    expect(operated(docker).slice(-2)).toEqual([
      "exec -T runtime nylorun-operate keys rm backend --json",
      "exec -T runtime nylorun-operate keys rm backend --json",
    ]);
  });

  it("put --management puts a management key, which list shows by role and rm deletes", async () => {
    const { deps, keys, docker } = await running();
    expect(await keyCommand(deps, ["put", "ops", "--management"])).toBe(0);
    expect(keys.get("ops")).toMatchObject({ role: "management" });
    expect(deps.lines).toEqual([keys.get("ops")!.key]);
    expect(deps.errors).toEqual([
      "Created management key ops on Tenant home-root. Store it now: it is not shown again.",
    ]);
    expect(operated(docker)).toEqual([
      "exec -T runtime nylorun-operate keys put ops --role management --json",
    ]);

    await keyCommand(deps, ["put", "backend"]);
    deps.lines.length = 0;
    expect(await keyCommand(deps, ["list"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID       ROLE         CREATED",
      "ops      management   2026-10-04T00:00:00.000Z",
      "backend  application  2026-10-04T00:00:00.000Z",
    ]);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["rm", "ops"])).toBe(0);
    expect(keys.has("ops")).toBe(false);
  });

  it("reports nylorun-operate's refusal, an unopenable Tenant, and checks its arguments", async () => {
    const { deps } = await running();
    await expect(keyCommand(deps, ["put", "studio"])).rejects.toMatchObject({
      message: "The studio key is derived from the admin key",
      exitCode: 1,
    });
    const closed = fakeDocker({
      respond: (args) =>
        args.includes("ps")
          ? psUp
          : args.includes("nylorun-operate")
            ? { code: 2, stdout: "", stderr: "The database holds no Tenant yet: start the Runtime first\n" }
            : undefined,
    });
    await expect(keyCommand({ ...deps, docker: closed }, ["list"])).rejects.toMatchObject({
      message: "The Tenant is not open: The database holds no Tenant yet: start the Runtime first",
      exitCode: 7,
    });
    const missing = fakeDocker({
      respond: (args) =>
        args.includes("ps")
          ? psUp
          : args.includes("nylorun-operate")
            ? { code: 127, stdout: "", stderr: "exec: \"nylorun-operate\": executable file not found" }
            : undefined,
    });
    await expect(keyCommand({ ...deps, docker: missing }, ["list"])).rejects.toThrow(
      /nylorun-operate keys list failed \(exit 127\): exec: "nylorun-operate": executable file not found/,
    );
    await expect(keyCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(keyCommand(deps, ["put"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(keyCommand(deps, ["rm", "a", "b"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("the keys nylorun commands use", () => {
  it("are the linked project's keys when they authenticate, else the cli keys", async () => {
    const { deps, keys, fetch, docker, home } = await running({ project: true });
    // start linked the project with the keys `project` and `project-management`.
    expect(keys.get("project")).toMatchObject({ role: "application" });
    expect(keys.get("project-management")).toMatchObject({ role: "management" });
    const api = await runningTenantApi(deps);
    expect(api.applicationKey).toBe(keys.get("project")!.key);
    expect(api.managementKey).toBe(keys.get("project-management")!.key);
    expect(operated(docker)).toEqual([]);
    expect(fetch.requests.filter((r) => r.url.endsWith("/v1/me"))).toHaveLength(2);

    // Rotated elsewhere: the project's file no longer works, so the cli keys are put and kept.
    await keyCommand(deps, ["put", "project"]);
    docker.calls.length = 0;
    const fallback = await runningTenantApi(deps);
    expect(fallback.applicationKey).toBe(keys.get("cli")!.key);
    expect(fallback.managementKey).toBe(keys.get("cli-management")!.key);
    expect(operated(docker)).toEqual([
      "exec -T runtime nylorun-operate keys put cli --role application --json",
      "exec -T runtime nylorun-operate keys put cli-management --role management --json",
    ]);
    expect(JSON.parse(readFileSync(stackPaths(home).cliCredentials, "utf8"))).toEqual({
      format: 1,
      principalId: "cli",
      applicationKey: keys.get("cli")!.key,
      managementPrincipalId: "cli-management",
      managementKey: keys.get("cli-management")!.key,
    });

    // A cli file from before management keys keeps its application key and gains one.
    const { managementKey: _, managementPrincipalId: __, ...applicationOnly } = JSON.parse(
      readFileSync(stackPaths(home).cliCredentials, "utf8"),
    ) as Record<string, string>;
    await writeFile(stackPaths(home).cliCredentials, JSON.stringify(applicationOnly));
    keys.delete("cli-management");
    docker.calls.length = 0;
    const upgraded = await runningTenantApi(deps);
    expect(upgraded.applicationKey).toBe(fallback.applicationKey);
    expect(upgraded.managementKey).toBe(keys.get("cli-management")!.key);
    expect(operated(docker)).toEqual([
      "exec -T runtime nylorun-operate keys put cli-management --role management --json",
    ]);
  });
});
