import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { deriveTenantKey } from "../../src/project/derived-key.js";
import { runStackCommand, type StackDeps } from "../../src/stack/commands.js";
import { parseEnvLines } from "../../src/stack/env-file.js";
import { stackPaths } from "../../src/stack/paths.js";
import { chooseStackName, sanitizeStackName } from "../../src/stack/stacks.js";
import { fakeDocker, fakeFetch, json, temporaryDir, testDeps } from "./support.js";

/** A machine: `~/.nylorun` (`base`) and directories for projects, in one temporary directory. */
async function machine() {
  const tmp = await temporaryDir("nylorun-stacks-");
  return { tmp, base: join(tmp, "nylorun") };
}

/** A project directory (with package.json) and its `.env`. */
async function project(dir: string, env?: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), "{}");
  if (env !== undefined) await writeFile(join(dir, ".env"), env);
  return realpathSync(dir);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/**
 * A fetch that answers for every stack under `base`: the Host on each stack's Runtime port, its
 * Tenant (one id per stack, named after it) on its operator port, and the Tenant API.
 */
function machineFetch(base: string, options: { modelConfigured?: boolean } = {}) {
  const tenants = new Map<string, string>();
  const stackOn = (url: string, field: "port" | "adminPort") => {
    const port = Number(new URL(url).port);
    const stacks = join(base, "stacks");
    for (const name of existsSync(stacks) ? readdirSync(stacks) : []) {
      const host = join(stacks, name, "host.json");
      if (existsSync(host) && readJson(host)[field] === port)
        return { name, hostId: readJson(host).hostId as string };
    }
    return undefined;
  };
  const tenantOf = (name: string) => {
    if (!tenants.has(name)) tenants.set(name, newTenantId());
    return tenants.get(name)!;
  };
  const fetch = fakeFetch((url) => {
    if (url.endsWith("/health")) {
      const stack = stackOn(url, "port");
      return stack ? json({ status: "ok", version: "0.10.0-beta", hostId: stack.hostId }) : undefined;
    }
    if (url.endsWith("/v1/admin/status")) {
      const stack = stackOn(url, "adminPort");
      return stack
        ? json({ tenant: { id: tenantOf(stack.name), name: stack.name, state: "open", envelope: null } })
        : undefined;
    }
    if (url.endsWith("/v1/tenant/config/seed")) return json({ applied: ["sandbox"], kept: [] });
    if (url.endsWith("/v1/tenant/model"))
      return json(options.modelConfigured ? { configured: true, provider: "p", model: "m", authType: "api_key" } : { configured: false });
    return undefined;
  });
  return Object.assign(fetch, { tenantOf });
}

/** Dependencies for `~/.nylorun` = `base`, run in `cwd`, with no NYLORUN_HOME. */
function machineDeps(
  base: string,
  cwd: string,
  overrides: Partial<StackDeps> = {},
): ReturnType<typeof testDeps> {
  return testDeps(join(base, "unused"), {
    env: {},
    cwd,
    nylorunRoot: base,
    fetch: machineFetch(base),
    ...overrides,
  });
}

describe("start in a project", () => {
  it("creates the project's stack, its Tenant and the Project link", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "My Shop"));
    const fetch = machineFetch(base);
    const docker = fakeDocker();
    const deps = machineDeps(base, join(dir), { fetch, docker });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);

    const root = join(base, "stacks", "my-shop");
    const paths = stackPaths(root);
    expect(readJson(join(root, "stack.json"))).toEqual({ format: 1, name: "my-shop", project: dir });
    expect(docker.streamed[0]!.slice(0, 7)).toEqual([
      "compose", "--project-name", "nylorun-my-shop", "--file", paths.compose, "--env-file", paths.env,
    ]);
    expect(readFileSync(paths.compose, "utf8")).toMatch(/^name: nylorun-my-shop$/m);
    const env = parseEnvLines(readFileSync(paths.env, "utf8"));
    expect(env.get("NYLORUN_STACK_NAME")).toBe("my-shop");
    expect(env.get("NYLORUN_DERIVED_PRINCIPALS")).toBe("project");
    expect(existsSync(paths.tenant)).toBe(true);

    const tenantId = fetch.tenantOf("my-shop");
    const host = readJson(paths.config);
    expect(readJson(join(dir, ".nylorun", "link.json"))).toEqual({
      format: 2,
      stack: "my-shop",
      hostUrl: "http://localhost:8787",
      hostId: host.hostId,
      tenantId,
    });
    const { adminKey } = readJson(paths.credentials) as { adminKey: string };
    expect(readJson(join(dir, ".nylorun", "credentials.json"))).toEqual({
      format: 1,
      applicationKey: deriveTenantKey(adminKey, tenantId, "project"),
      principalId: "project",
    });
    expect(deps.lines.slice(0, 2)).toEqual([
      `Stack     my-shop  (${root})`,
      `Tenant    ${tenantId}  (my-shop)`,
    ]);
    expect(deps.errors).toContain(`Linked ${dir} to stack my-shop (.nylorun/link.json, .nylorun/credentials.json).`);
  });

  it("seeds a new link's Tenant from .env, with the project key and no Tenant header", async () => {
    const { tmp, base } = await machine();
    const dir = await project(
      join(tmp, "shop"),
      "NYLORUN_SANDBOX=virtual\nMODEL_PROVIDER=anthropic\nMODEL=claude-x\nMODEL_PROVIDER_API_KEY=sk-test\n",
    );
    const fetch = machineFetch(base);
    const deps = machineDeps(base, dir, { fetch });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    const tenantApi = fetch.requests.filter((r) => r.url.includes("/v1/tenant/"));
    expect(tenantApi.map((r) => `${r.init?.method ?? "GET"} ${r.url}`)).toEqual([
      "PUT http://localhost:8787/v1/tenant/config/seed",
      "GET http://localhost:8787/v1/tenant/model",
      "PUT http://localhost:8787/v1/tenant/model",
    ]);
    const key = (readJson(join(dir, ".nylorun", "credentials.json")) as { applicationKey: string }).applicationKey;
    for (const request of tenantApi) {
      const headers = request.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${key}`);
      expect(headers["Nylorun-Protocol"]).toBe("5");
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("nylorun-tenant");
    }
    expect(JSON.parse(tenantApi[0]!.init!.body as string)).toMatchObject({ sandbox: { backend: "virtual" } });
    expect(JSON.parse(tenantApi[2]!.init!.body as string)).toMatchObject({
      provider: "anthropic",
      model: "claude-x",
      auth: { type: "api_key", key: "sk-test" },
    });
    expect(deps.errors).toContain("Seeded the Tenant from .env: sandbox, model anthropic/claude-x.");

    // A later start reuses the stack and the link, and seeds nothing.
    const again = machineDeps(base, dir, { fetch });
    fetch.requests.length = 0;
    expect(await runStackCommand("start", ["--no-studio"], again)).toBe(0);
    expect(fetch.requests.filter((r) => r.url.includes("/v1/tenant/"))).toEqual([]);
    expect(again.errors.some((line) => line.startsWith("Linked") || line.startsWith("Created"))).toBe(false);
    expect(readdirSync(join(base, "stacks"))).toEqual(["shop"]);
  });

  it("keeps a configured model, and stores none for the fixture model", async () => {
    const { tmp, base } = await machine();
    const env = "MODEL_PROVIDER=anthropic\nMODEL=claude-x\nMODEL_PROVIDER_API_KEY=sk-test\n";
    const configured = machineFetch(base, { modelConfigured: true });
    const one = await project(join(tmp, "one"), env);
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, one, { fetch: configured }))).toBe(0);
    expect(configured.requests.filter((r) => r.init?.method === "PUT")).toEqual([]);

    const fixture = machineFetch(base);
    const two = await project(join(tmp, "two"), `${env}NYLORUN_DEV_MODEL=fixture\n`);
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, two, { fetch: fixture }))).toBe(0);
    expect(fixture.requests.filter((r) => r.url.includes("/v1/tenant/"))).toEqual([]);
  });

  it("gives a second project of the same directory name its own stack, on its own ports", async () => {
    const { tmp, base } = await machine();
    const first = await project(join(tmp, "a", "app"));
    const second = await project(join(tmp, "b", "app"));
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, first))).toBe(0);
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, second))).toBe(0);
    expect(readJson(join(second, ".nylorun", "link.json")).stack).toBe("app-2");
    expect(readJson(join(base, "stacks", "app-2", "stack.json")).project).toBe(second);
    expect(readJson(join(second, ".nylorun", "link.json")).hostUrl).toBe("http://localhost:50000");
    // A fresh clone at the first path finds the stack created for it.
    expect(await chooseStackName(base, first)).toBe("app");
    expect(await chooseStackName(base, await project(join(tmp, "c", "app")))).toBe("app-3");
  });

  it("--name attaches another checkout to an existing stack", async () => {
    const { tmp, base } = await machine();
    const fetch = machineFetch(base);
    const main = await project(join(tmp, "app"));
    const worktree = await project(join(tmp, "app-feature"));
    await runStackCommand("start", ["--no-studio"], machineDeps(base, main, { fetch }));
    expect(await runStackCommand("start", ["--no-studio", "--name", "app"], machineDeps(base, worktree, { fetch }))).toBe(0);
    expect(readJson(join(worktree, ".nylorun", "link.json"))).toEqual(
      readJson(join(main, ".nylorun", "link.json")),
    );
    expect(readdirSync(join(base, "stacks"))).toEqual(["app"]);
    // The linked worktree then selects that stack on its own.
    const status = machineDeps(base, worktree);
    await runStackCommand("status", ["--json"], status);
    expect(JSON.parse(status.lines.join("\n")).name).toBe("app");
  });

  it("replaces a link to a Tenant on an older Runtime's stack with the project's own stack", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "shop"));
    await mkdir(join(dir, ".nylorun"));
    await writeFile(
      join(dir, ".nylorun", "link.json"),
      JSON.stringify({ format: 1, hostUrl: "http://localhost:8787", hostId: "host_old", tenantId: "tn_old" }),
    );
    const deps = machineDeps(base, dir);
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(deps.errors.some((line) => /linked to a Tenant on http:\/\/localhost:8787, a stack of an older Runtime/.test(line))).toBe(true);
    expect(readJson(join(dir, ".nylorun", "link.json"))).toMatchObject({ format: 2, stack: "shop" });
  });

  it("--no-link starts a named stack and leaves the project alone", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "repo"));
    await expect(
      runStackCommand("start", ["--no-link"], machineDeps(base, dir)),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(await runStackCommand("start", ["--no-studio", "--no-link", "--name", "smoke"], machineDeps(base, dir))).toBe(0);
    expect(existsSync(join(dir, ".nylorun"))).toBe(false);
    expect(readJson(join(base, "stacks", "smoke", "stack.json"))).toEqual({ format: 1, name: "smoke" });
  });
});

describe("outside a project", () => {
  it("start needs a name and writes no link; other commands need a stack", async () => {
    const { tmp, base } = await machine();
    await expect(runStackCommand("start", [], machineDeps(base, tmp))).rejects.toThrow(
      /Not in a project: name the stack with "nylorun start --name <stack>"/,
    );
    expect(await runStackCommand("start", ["--no-studio", "--name", "scratch"], machineDeps(base, tmp))).toBe(0);
    expect(existsSync(join(tmp, ".nylorun"))).toBe(false);
    const status = runStackCommand("status", [], machineDeps(base, tmp));
    await expect(status).rejects.toMatchObject({ exitCode: 2 });
    await expect(status).rejects.toThrow(/No stack selected.*Stacks on this machine: scratch\./);
    await expect(runStackCommand("status", ["--name", "Bad"], machineDeps(base, tmp))).rejects.toThrow(/--name must be lowercase/);
    const named = machineDeps(base, tmp, { env: { NYLORUN_STACK: "scratch" } });
    expect(await runStackCommand("status", ["--json"], named)).toBe(0);
    expect(JSON.parse(named.lines.join("\n")).project).toBe("nylorun-scratch");
  });

  it("sanitises directory names into stack names", () => {
    expect(sanitizeStackName("My Shop!")).toBe("my-shop");
    expect(sanitizeStackName("--Agents.Foundation__")).toBe("agents-foundation");
    expect(sanitizeStackName("日本")).toBe("stack");
  });
});

describe("ls", () => {
  it("lists the stacks with their project, ports and state", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio"], machineDeps(base, await project(join(tmp, "app"))));
    await runStackCommand("start", ["--no-studio", "--name", "scratch"], machineDeps(base, tmp));
    const docker = fakeDocker({
      respond: (args) =>
        args[1] === "ls"
          ? { code: 0, stdout: JSON.stringify([{ Name: "nylorun-app", Status: "running(6)" }]), stderr: "" }
          : undefined,
    });
    const deps = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("ls", ["--json"], deps)).toBe(0);
    const listed = JSON.parse(deps.lines.join("\n")) as { stacks: Record<string, unknown>[]; legacy?: unknown };
    expect(listed.legacy).toBeUndefined();
    expect(listed.stacks).toEqual([
      {
        name: "app",
        root: join(base, "stacks", "app"),
        project: realpathSync(join(tmp, "app")),
        state: "running",
        runtimeUrl: "http://localhost:8787",
        studioUrl: "http://localhost:4161",
        ports: { runtime: 8787, admin: 8788, studio: 4161, restate: 9070 },
      },
      expect.objectContaining({ name: "scratch", state: "stopped", ports: { runtime: 50000, admin: 50001, studio: 50002, restate: 50003 } }),
    ]);
    expect(docker.calls.filter((args) => args[0] === "compose")).toEqual([["compose", "ls", "--all", "--format", "json"]]);

    const words = machineDeps(base, tmp, {
      docker: fakeDocker({ respond: () => ({ code: 127, stdout: "", stderr: "", missing: true }) }),
    });
    expect(await runStackCommand("ls", [], words)).toBe(0);
    expect(words.lines[0]).toMatch(/^NAME\s+STATE\s+RUNTIME\s+STUDIO\s+PROJECT$/);
    expect(words.lines[1]).toMatch(/^app\s+unknown\s+http:\/\/localhost:8787\s+http:\/\/localhost:4161\s+\//);
  });

  it("says when there are no stacks", async () => {
    const { tmp, base } = await machine();
    const deps = machineDeps(base, tmp);
    expect(await runStackCommand("ls", [], deps)).toBe(0);
    expect(deps.lines).toEqual([`No stacks under ${join(base, "stacks")}. Run "npx nylorun start" in a project.`]);
  });
});

describe("delete", () => {
  it("refuses without --yes, then removes the containers, volumes and Host root", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio", "--name", "scratch"], machineDeps(base, tmp));
    const root = join(base, "stacks", "scratch");
    const docker = fakeDocker();
    const refused = runStackCommand("delete", ["scratch"], machineDeps(base, tmp, { docker }));
    await expect(refused).rejects.toMatchObject({ exitCode: 2 });
    await expect(refused).rejects.toThrow(/vault key \(KEK\) and all its data/);
    expect(docker.streamed).toEqual([]);
    expect(await runStackCommand("delete", ["scratch", "--yes"], machineDeps(base, tmp, { docker }))).toBe(0);
    expect(docker.streamed).toEqual([
      [
        "compose", "--project-name", "nylorun-scratch",
        "--file", join(root, "docker", "compose.yaml"), "--env-file", join(root, "docker", ".env"),
        "down", "--volumes", "--remove-orphans",
      ],
    ]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(base, "stacks"))).toBe(true);
    await expect(runStackCommand("delete", ["scratch", "--yes"], machineDeps(base, tmp))).rejects.toMatchObject({ exitCode: 3 });
    await expect(runStackCommand("delete", [], machineDeps(base, tmp))).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("the legacy stack", () => {
  /** The single stack of an older release, directly under `base`. */
  async function legacyLayout(base: string) {
    await mkdir(join(base, "stack"), { recursive: true });
    await mkdir(join(base, "tenants", "tn_x"), { recursive: true });
    await writeFile(join(base, "stack", "compose.yaml"), "name: nylorun\n");
    await writeFile(join(base, "stack", ".env"), "NYLORUN_PORT=8787\nNYLORUN_STUDIO_PORT=4161\n");
    await writeFile(join(base, "host.json"), "{}");
    await writeFile(join(base, "host-credentials.json"), "{}");
  }

  it("start mentions it once and keeps clear of its ports", async () => {
    const { tmp, base } = await machine();
    await legacyLayout(base);
    const deps = machineDeps(base, await project(join(tmp, "app")));
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(deps.errors.filter((line) => line.includes("nylorun legacy stop"))).toHaveLength(1);
    expect(readJson(join(base, "stacks", "app", "host.json")).port).toBe(50000);
    const again = machineDeps(base, join(tmp, "app"));
    await runStackCommand("start", ["--no-studio"], again);
    expect(again.errors.some((line) => line.includes("legacy"))).toBe(false);
    const listed = machineDeps(base, tmp);
    await runStackCommand("ls", ["--json"], listed);
    expect(JSON.parse(listed.lines.join("\n")).legacy).toEqual({ root: base, project: "nylorun", state: "stopped" });
  });

  it("legacy stop stops Compose project nylorun; legacy delete --yes removes only the old layout", async () => {
    const { tmp, base } = await machine();
    await legacyLayout(base);
    await runStackCommand("start", ["--no-studio", "--name", "keep"], machineDeps(base, tmp));
    const legacyCompose = [
      "compose", "--project-name", "nylorun",
      "--file", join(base, "stack", "compose.yaml"), "--env-file", join(base, "stack", ".env"),
    ];
    const docker = fakeDocker();
    expect(await runStackCommand("legacy", ["stop"], machineDeps(base, tmp, { docker }))).toBe(0);
    await expect(runStackCommand("legacy", ["delete"], machineDeps(base, tmp, { docker }))).rejects.toThrow(
      /every Tenant on it with their vault keys.*Pass --yes/,
    );
    expect(await runStackCommand("legacy", ["delete", "--yes"], machineDeps(base, tmp, { docker }))).toBe(0);
    expect(docker.streamed).toEqual([
      [...legacyCompose, "stop"],
      [...legacyCompose, "down", "--volumes", "--remove-orphans"],
    ]);
    expect(readdirSync(base).sort()).toEqual(["stacks"]);
    expect(existsSync(join(base, "stacks", "keep", "host.json"))).toBe(true);
    const none = machineDeps(base, tmp);
    expect(await runStackCommand("legacy", ["stop"], none)).toBe(0);
    expect(none.lines[0]).toMatch(/^No legacy stack under /);
    await expect(runStackCommand("legacy", ["start"], none)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("reset", () => {
  it("resets only the selected stack, and the next start relinks the project", async () => {
    const { tmp, base } = await machine();
    const fetch = machineFetch(base);
    const dir = await project(join(tmp, "app"));
    await runStackCommand("start", ["--no-studio"], machineDeps(base, dir, { fetch }));
    await runStackCommand("start", ["--no-studio", "--name", "other"], machineDeps(base, tmp, { fetch }));
    await writeFile(join(base, "stacks", "other", "tenant", "vault-kek"), "kek");
    await writeFile(join(base, "stacks", "app", "tenant", "vault-kek"), "kek");
    const docker = fakeDocker();
    expect(await runStackCommand("reset", ["--yes"], machineDeps(base, dir, { docker, fetch }))).toBe(0);
    expect(docker.streamed.map((args) => args[2])).toEqual(["nylorun-app"]);
    expect(existsSync(join(base, "stacks", "app", "tenant", "vault-kek"))).toBe(false);
    expect(existsSync(join(base, "stacks", "other", "tenant", "vault-kek"))).toBe(true);

    // The Runtime creates a new Tenant after a reset: start rewrites the link.
    const before = readJson(join(dir, ".nylorun", "link.json")).tenantId;
    const fresh = machineFetch(base);
    const restart = machineDeps(base, dir, { fetch: fresh });
    await runStackCommand("start", ["--no-studio"], restart);
    const after = readJson(join(dir, ".nylorun", "link.json")).tenantId;
    expect(after).not.toBe(before);
    expect(after).toBe(fresh.tenantOf("app"));
    expect(await readFile(join(dir, ".nylorun", "credentials.json"), "utf8")).toContain(
      deriveTenantKey((readJson(join(base, "stacks", "app", "host-credentials.json")) as { adminKey: string }).adminKey, after as string, "project"),
    );
  });
});
