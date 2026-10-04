import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runningTenantApi, runStackCommand } from "../../src/stack/commands.js";
import { keyCommand } from "../../src/stack/keys.js";
import { stackPaths } from "../../src/stack/paths.js";
import { fakeDocker, fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "./support.js";

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

/** A running Tenant whose Admin API keeps operator keys and whose Tenant API checks them. */
async function running(options: { project?: boolean } = {}) {
  const home = await temporaryHome();
  const keys = new Map<string, { key: string; createdAt: string }>();
  const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : undefined) });
  const fetch = fakeFetch((url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/health") {
      const { hostId } = JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string };
      return json({ status: "ok", version: "0.10.0-beta", hostId });
    }
    if (path === "/v1/admin/status")
      return json({ tenant: { id: TENANT_ID, name: "t", state: "open", envelope: null } });
    if (path === "/v1/admin/keys" && method === "GET")
      return json({
        keys: [...keys].map(([id, { createdAt }]) => ({ id, role: "application", createdAt })),
      });
    const key = /^\/v1\/admin\/keys\/(.+)$/.exec(path)?.[1];
    if (key === "studio")
      return json({ status: "rejected", code: "request_rejected", message: "The studio key is derived from the admin key" }, 400);
    if (key && method === "PUT") {
      const rotated = keys.has(key);
      const value = { key: randomBytes(32).toString("hex"), createdAt: "2026-10-04T00:00:00.000Z" };
      keys.set(key, value);
      return json({ id: key, role: "application", createdAt: value.createdAt, key: value.key, rotated });
    }
    if (key && method === "DELETE")
      return keys.delete(key)
        ? json({ id: key, deleted: true })
        : json({ status: "rejected", code: "not_found", message: `No key ${key}` }, 404);
    if (path === "/v1/tenant") {
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
      return [...keys.values()].some((value) => value.key === bearer)
        ? json({ tenant: { id: TENANT_ID } })
        : json({ status: "rejected", code: "not_found", message: "Not found" }, 404);
    }
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
  return { home, deps, fetch, keys, cwd };
}

describe("nylorun key", () => {
  it("put prints the key once, list shows ids without keys, rm deletes", async () => {
    const { deps, keys } = await running();
    expect(await keyCommand(deps, ["put", "babai"])).toBe(0);
    expect(deps.lines).toEqual([keys.get("babai")!.key]);
    expect(deps.errors).toEqual([
      "Created key babai on Tenant home-root. Store it now: it is not shown again.",
    ]);

    deps.lines.length = 0;
    deps.errors.length = 0;
    expect(await keyCommand(deps, ["put", "babai"])).toBe(0);
    expect(deps.errors[0]).toMatch(/^Rotated key babai on Tenant home-root \(the previous key no longer works\)/);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["list"])).toBe(0);
    expect(deps.lines).toEqual([
      "ID     ROLE         CREATED",
      "babai  application  2026-10-04T00:00:00.000Z",
    ]);
    expect(deps.lines.join("\n")).not.toContain(keys.get("babai")!.key);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["list", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toEqual([
      { id: "babai", role: "application", createdAt: "2026-10-04T00:00:00.000Z" },
    ]);

    deps.lines.length = 0;
    expect(await keyCommand(deps, ["rm", "babai"])).toBe(0);
    expect(deps.lines).toEqual(["Deleted key babai: it no longer works."]);
    expect(await keyCommand(deps, ["rm", "babai"])).toBe(1);
    expect(deps.errors.at(-1)).toBe("No key babai on Tenant home-root.");
  });

  it("reports the Runtime's refusal of studio, and checks its arguments", async () => {
    const { deps } = await running();
    await expect(keyCommand(deps, ["put", "studio"])).rejects.toThrow(
      /PUT \/v1\/admin\/keys\/studio returned 400: The studio key is derived/,
    );
    await expect(keyCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(keyCommand(deps, ["put"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(keyCommand(deps, ["rm", "a", "b"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("says when the Runtime is too old for operator keys", async () => {
    const { deps, fetch } = await running();
    const old = fakeFetch((url, init) =>
      url.includes("/v1/admin/keys")
        ? json({ status: "rejected", code: "not_found", message: "Route not found" }, 404)
        : fetch(url, init),
    );
    await expect(keyCommand({ ...deps, fetch: old }, ["list"])).rejects.toThrow(
      /does not serve operator keys/,
    );
  });
});

describe("the key nylorun commands use", () => {
  it("is the linked project's key when it authenticates, else the cli key", async () => {
    const { deps, keys, fetch, home } = await running({ project: true });
    // start linked the project with the operator key `project`.
    expect(keys.has("project")).toBe(true);
    const api = await runningTenantApi(deps);
    expect(api.applicationKey).toBe(keys.get("project")!.key);
    expect(fetch.requests.filter((r) => r.url.includes("/v1/admin/keys"))).toEqual([]);

    // Rotated elsewhere: the project's file no longer works, so the cli key is put and kept.
    await keyCommand(deps, ["put", "project"]);
    const fallback = await runningTenantApi(deps);
    expect(fallback.applicationKey).toBe(keys.get("cli")!.key);
    expect(JSON.parse(readFileSync(stackPaths(home).cliCredentials, "utf8"))).toMatchObject({
      principalId: "cli",
      applicationKey: keys.get("cli")!.key,
    });
  });
});
