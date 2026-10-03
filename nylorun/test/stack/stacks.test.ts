import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { deriveTenantKey } from "../../src/project/derived-key.js";
import { runStackCommand, type StackDeps } from "../../src/stack/commands.js";
import { parseEnvLines } from "../../src/stack/env-file.js";
import { stackPaths } from "../../src/stack/paths.js";
import { chooseTenantName, sanitizeTenantName } from "../../src/stack/stacks.js";
import { doctorStack } from "../../src/doctor.js";
import { fakeDocker, fakeFetch, fakePorts, json, temporaryDir, testDeps } from "./support.js";

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
 * A fetch that answers for every Tenant under `base`: the Host on each Tenant's Runtime port, the
 * Tenant (one id per name) on its operator port, and the Tenant API.
 */
function machineFetch(base: string, options: { modelConfigured?: boolean } = {}) {
  const tenants = new Map<string, string>();
  const tenantOn = (url: string, field: "port" | "adminPort") => {
    const port = Number(new URL(url).port);
    const tenants = join(base, "tenants");
    for (const name of existsSync(tenants) ? readdirSync(tenants) : []) {
      const host = join(tenants, name, "host.json");
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
      const tenant = tenantOn(url, "port");
      return tenant ? json({ status: "ok", version: "0.10.0-beta", hostId: tenant.hostId }) : undefined;
    }
    if (url.endsWith("/v1/admin/status")) {
      const tenant = tenantOn(url, "adminPort");
      return tenant
        ? json({ tenant: { id: tenantOf(tenant.name), name: tenant.name, state: "open", envelope: null } })
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
  it("creates the project's Tenant and the Project link", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "My Shop"));
    const fetch = machineFetch(base);
    const docker = fakeDocker();
    const deps = machineDeps(base, join(dir), { fetch, docker });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);

    const root = join(base, "tenants", "my-shop");
    const paths = stackPaths(root);
    expect(readJson(join(root, "tenant.json"))).toEqual({ format: 1, name: "my-shop", project: dir });
    expect(docker.streamed[0]!.slice(0, 7)).toEqual([
      "compose", "--project-name", "nylorun-my-shop", "--file", paths.compose, "--env-file", paths.env,
    ]);
    expect(readFileSync(paths.compose, "utf8")).toMatch(/^name: nylorun-my-shop$/m);
    const env = parseEnvLines(readFileSync(paths.env, "utf8"));
    expect(env.get("NYLORUN_TENANT_NAME")).toBe("my-shop");
    expect(env.get("NYLORUN_DERIVED_PRINCIPALS")).toBe("project");
    expect(existsSync(paths.tenant)).toBe(true);

    const tenantId = fetch.tenantOf("my-shop");
    const host = readJson(paths.config);
    expect(readJson(join(dir, ".nylorun", "link.json"))).toEqual({
      format: 3,
      tenant: "my-shop",
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
    expect(deps.lines.slice(0, 2)).toEqual([`Tenant    my-shop  (${tenantId})`, "Runtime   http://localhost:8787"]);
    expect(deps.errors).toContain(
      `Created Tenant my-shop under ${root} (Runtime port 8787, Studio port 4161).`,
    );
    expect(deps.errors).toContain(`Linked ${dir} to Tenant my-shop (.nylorun/link.json, .nylorun/credentials.json).`);
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

    // A later start reuses the Tenant and the link, and seeds nothing.
    const again = machineDeps(base, dir, { fetch });
    fetch.requests.length = 0;
    expect(await runStackCommand("start", ["--no-studio"], again)).toBe(0);
    expect(fetch.requests.filter((r) => r.url.includes("/v1/tenant/"))).toEqual([]);
    expect(again.errors.some((line) => line.startsWith("Linked") || line.startsWith("Created"))).toBe(false);
    expect(readdirSync(join(base, "tenants"))).toEqual(["shop"]);
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

  it("gives a second project of the same directory name its own Tenant, on its own ports", async () => {
    const { tmp, base } = await machine();
    const first = await project(join(tmp, "a", "app"));
    const second = await project(join(tmp, "b", "app"));
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, first))).toBe(0);
    expect(await runStackCommand("start", ["--no-studio"], machineDeps(base, second))).toBe(0);
    expect(readJson(join(second, ".nylorun", "link.json")).tenant).toBe("app-2");
    expect(readJson(join(base, "tenants", "app-2", "tenant.json")).project).toBe(second);
    expect(readJson(join(second, ".nylorun", "link.json")).hostUrl).toBe("http://localhost:50000");
    // A fresh clone at the first path finds the Tenant created for it.
    expect(await chooseTenantName(base, first)).toBe("app");
    expect(await chooseTenantName(base, await project(join(tmp, "c", "app")))).toBe("app-3");
  });

  it("--tenant attaches another checkout to an existing Tenant", async () => {
    const { tmp, base } = await machine();
    const fetch = machineFetch(base);
    const main = await project(join(tmp, "app"));
    const worktree = await project(join(tmp, "app-feature"));
    await runStackCommand("start", ["--no-studio"], machineDeps(base, main, { fetch }));
    expect(await runStackCommand("start", ["--no-studio", "--tenant", "app"], machineDeps(base, worktree, { fetch }))).toBe(0);
    expect(readJson(join(worktree, ".nylorun", "link.json"))).toEqual(
      readJson(join(main, ".nylorun", "link.json")),
    );
    expect(readdirSync(join(base, "tenants"))).toEqual(["app"]);
    // The linked worktree then selects that Tenant on its own.
    const status = machineDeps(base, worktree);
    await runStackCommand("status", ["--json"], status);
    expect(JSON.parse(status.lines.join("\n")).name).toBe("app");
  });

  it("replaces a link of an older nylorun (format 2) as if there were none", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "shop"));
    await mkdir(join(dir, ".nylorun"));
    await writeFile(
      join(dir, ".nylorun", "link.json"),
      JSON.stringify({ format: 2, stack: "other", hostUrl: "http://localhost:8787", hostId: "host_old", tenantId: "tn_old" }),
    );
    const status = runStackCommand("status", [], machineDeps(base, dir));
    await expect(status).rejects.toThrow(/^No Tenant selected/);
    const deps = machineDeps(base, dir);
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(deps.errors.filter((line) => /an older/.test(line))).toEqual([]);
    expect(readJson(join(dir, ".nylorun", "link.json"))).toMatchObject({ format: 3, tenant: "shop" });
    expect(readJson(join(dir, ".nylorun", "link.json")).stack).toBeUndefined();
  });

  it("other commands need a link, --tenant or NYLORUN_TENANT", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio", "--no-link", "--tenant", "scratch"], machineDeps(base, tmp));
    const dir = await project(join(tmp, "repo"));
    const status = runStackCommand("status", [], machineDeps(base, dir));
    await expect(status).rejects.toMatchObject({ exitCode: 2 });
    await expect(status).rejects.toThrow(
      'No Tenant selected: run "nylorun start" in this project, pass --tenant <name>, or set NYLORUN_TENANT. Tenants on this machine: scratch.',
    );
  });

  it("--no-link starts the default Tenant and leaves the project alone", async () => {
    const { tmp, base } = await machine();
    const dir = await project(join(tmp, "repo"));
    expect(await runStackCommand("start", ["--no-studio", "--no-link"], machineDeps(base, dir))).toBe(0);
    expect(readJson(join(base, "tenants", "default", "tenant.json"))).toEqual({ format: 1, name: "default" });
    expect(await runStackCommand("start", ["--no-studio", "--no-link", "--tenant", "smoke"], machineDeps(base, dir))).toBe(0);
    expect(existsSync(join(dir, ".nylorun"))).toBe(false);
    expect(readJson(join(base, "tenants", "smoke", "tenant.json"))).toEqual({ format: 1, name: "smoke" });
  });
});

describe("outside a project", () => {
  it("start uses the default Tenant and writes no link; so do the other commands", async () => {
    const { tmp, base } = await machine();
    const started = machineDeps(base, tmp);
    expect(await runStackCommand("start", ["--no-studio"], started)).toBe(0);
    expect(started.lines[0]).toMatch(/^Tenant {4}default {2}\(tn_\w+\)$/);
    expect(readJson(join(base, "tenants", "default", "tenant.json"))).toEqual({ format: 1, name: "default" });
    expect(existsSync(join(tmp, ".nylorun"))).toBe(false);
    const status = machineDeps(base, tmp);
    expect(await runStackCommand("status", ["--json"], status)).toBe(0);
    expect(JSON.parse(status.lines.join("\n")).project).toBe("nylorun-default");
    expect(await runStackCommand("start", ["--no-studio", "--tenant", "scratch"], machineDeps(base, tmp))).toBe(0);
    await expect(runStackCommand("status", ["--tenant", "Bad"], machineDeps(base, tmp))).rejects.toThrow(/--tenant must be lowercase/);
    const named = machineDeps(base, tmp, { env: { NYLORUN_TENANT: "scratch" } });
    expect(await runStackCommand("status", ["--json"], named)).toBe(0);
    expect(JSON.parse(named.lines.join("\n")).project).toBe("nylorun-scratch");
  });

  it("refuses a Tenant id where a Tenant's name belongs", async () => {
    const { tmp, base } = await machine();
    const flag = runStackCommand("start", ["--tenant", "tn_x"], machineDeps(base, tmp));
    await expect(flag).rejects.toMatchObject({ exitCode: 2 });
    await expect(flag).rejects.toThrow(/^--tenant must be a Tenant's name, not a Tenant id: tn_x\. "nylorun ls" lists/);
    const env = machineDeps(base, tmp, { env: { NYLORUN_TENANT: "tn_01OLD" } });
    await expect(runStackCommand("status", [], env)).rejects.toThrow(/^NYLORUN_TENANT must be a Tenant's name/);
    expect(existsSync(join(base, "tenants"))).toBe(false);
  });

  it("sanitises directory names into Tenant names", () => {
    expect(sanitizeTenantName("My Shop!")).toBe("my-shop");
    expect(sanitizeTenantName("--Agents.Foundation__")).toBe("agents-foundation");
    expect(sanitizeTenantName("tn_shop")).toBe("tn-shop");
    expect(sanitizeTenantName("日本")).toBe("tenant");
  });
});

describe("ls", () => {
  it("lists the Tenants with their project, ports, state and memory, and nothing else under tenants/", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio"], machineDeps(base, await project(join(tmp, "app"))));
    await runStackCommand("start", ["--no-studio", "--tenant", "scratch"], machineDeps(base, tmp));
    // A release before 0.4 kept a directory per Tenant id here.
    await mkdir(join(base, "tenants", "tn_01old", "home"), { recursive: true });
    const docker = fakeDocker({
      respond: (args) => {
        if (args[1] === "ls")
          return { code: 0, stdout: JSON.stringify([{ Name: "nylorun-app", Status: "running(6)" }]), stderr: "" };
        if (args[0] === "ps")
          return { code: 0, stdout: "nylorun-app-postgres\tapp\nnylorun-app-runtime\tapp\n", stderr: "" };
        if (args[0] === "stats")
          return { code: 0, stdout: "nylorun-app-postgres\t100MiB / 7.6GiB\nnylorun-app-runtime\t1.5GiB / 7.6GiB\n", stderr: "" };
        return undefined;
      },
    });
    const deps = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("ls", ["--json"], deps)).toBe(0);
    const listed = JSON.parse(deps.lines.join("\n")) as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(listed)).toEqual(["tenants"]);
    expect(listed.tenants).toEqual([
      {
        name: "app",
        root: join(base, "tenants", "app"),
        project: realpathSync(join(tmp, "app")),
        state: "running",
        memoryBytes: 100 * 2 ** 20 + 1.5 * 2 ** 30,
        runtimeUrl: "http://localhost:8787",
        // Through the proxy, whose port the first start chose.
        studioUrl: "http://app.localhost:4160",
        ports: { runtime: 8787, admin: 8788, studio: 4161, restate: 9070 },
      },
      expect.objectContaining({ name: "scratch", state: "stopped", memoryBytes: null, ports: { runtime: 50000, admin: 50001, studio: 50002, restate: 50003 } }),
    ]);
    expect(docker.calls.filter((args) => args[0] === "compose")).toEqual([["compose", "ls", "--all", "--format", "json"]]);
    expect(docker.calls.filter((args) => args[0] === "stats")).toEqual([
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", "nylorun-app-postgres", "nylorun-app-runtime"],
    ]);
    const table = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("ls", [], table)).toBe(0);
    expect(table.lines[1]).toMatch(/^app\s+running\s+1\.7 GB\s+http:\/\/localhost:8787\s+http:\/\/app\.localhost:4160\s+\//);

    const words = machineDeps(base, tmp, {
      docker: fakeDocker({ respond: () => ({ code: 127, stdout: "", stderr: "", missing: true }) }),
    });
    expect(await runStackCommand("ls", [], words)).toBe(0);
    expect(words.lines[0]).toMatch(/^TENANT\s+STATE\s+MEMORY\s+RUNTIME\s+STUDIO\s+PROJECT$/);
    expect(words.lines).toHaveLength(3);
    expect(words.lines[1]).toMatch(/^app\s+unknown\s+-\s+http:\/\/localhost:8787\s+http:\/\/app\.localhost:4160\s+\//);
    // Without the proxy, Studio's own port.
    const direct = machineDeps(base, tmp, { env: { NYLORUN_PROXY_DISABLED: "1" } });
    expect(await runStackCommand("ls", ["--json"], direct)).toBe(0);
    expect(JSON.parse(direct.lines.join("\n")).tenants[0].studioUrl).toBe("http://localhost:4161");
  });

  it("says when there are no Tenants", async () => {
    const { tmp, base } = await machine();
    const deps = machineDeps(base, tmp);
    expect(await runStackCommand("ls", [], deps)).toBe(0);
    expect(deps.lines).toEqual([
      'No Tenants on this machine. Run "npx nylorun start" in a project (or anywhere, for the default Tenant).',
    ]);
  });
});

describe("delete", () => {
  it("refuses without --yes, then removes the containers, volumes and Host root", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio", "--tenant", "scratch"], machineDeps(base, tmp));
    const root = join(base, "tenants", "scratch");
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
    expect(existsSync(join(base, "tenants"))).toBe(true);
    await expect(runStackCommand("delete", ["scratch", "--yes"], machineDeps(base, tmp))).rejects.toMatchObject({ exitCode: 3 });
    await expect(runStackCommand("delete", [], machineDeps(base, tmp))).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("the Host roots of nylorun 0.4", () => {
  it("move from stacks/ to tenants/ once, with tenant.json and NYLORUN_TENANT_NAME", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio", "--tenant", "shop"], machineDeps(base, tmp));
    await runStackCommand("start", ["--no-studio", "--tenant", "taken"], machineDeps(base, tmp));
    // Lay out shop as 0.4 kept it, and a stacks/taken whose name tenants/ already holds.
    const old = join(base, "stacks");
    await mkdir(old);
    await rename(join(base, "tenants", "shop"), join(old, "shop"));
    await rename(join(old, "shop", "tenant.json"), join(old, "shop", "stack.json"));
    for (const file of [join(old, "shop", "docker", ".env"), join(old, "shop", "docker", "compose.yaml")])
      await writeFile(file, readFileSync(file, "utf8").replaceAll("NYLORUN_TENANT_NAME", "NYLORUN_STACK_NAME"));
    await mkdir(join(old, "taken"));
    await writeFile(join(old, ".legacy-noted"), "");

    const deps = machineDeps(base, tmp);
    expect(await runStackCommand("ls", ["--json"], deps)).toBe(0);
    expect(deps.errors).toEqual([`Moved Tenants shop from ${old} to ${join(base, "tenants")}.`]);
    expect(JSON.parse(deps.lines.join("\n")).tenants.map((t: { name: string }) => t.name)).toEqual(["shop", "taken"]);
    const root = join(base, "tenants", "shop");
    expect(readJson(join(root, "tenant.json"))).toEqual({ format: 1, name: "shop" });
    expect(parseEnvLines(readFileSync(join(root, "docker", ".env"), "utf8")).get("NYLORUN_TENANT_NAME")).toBe("shop");
    expect(readFileSync(join(root, "docker", "compose.yaml"), "utf8")).not.toContain("NYLORUN_STACK_NAME");
    expect(readdirSync(old)).toEqual(["taken"]);

    const again = machineDeps(base, tmp);
    await runStackCommand("status", ["--tenant", "shop", "--json"], again);
    expect(again.errors).toEqual([]);
    await rm(join(old, "taken"), { recursive: true });
    await runStackCommand("ls", [], machineDeps(base, tmp));
    expect(existsSync(old)).toBe(false);
  });
});

describe("reset", () => {
  it("resets only the selected Tenant, and the next start relinks the project", async () => {
    const { tmp, base } = await machine();
    const fetch = machineFetch(base);
    const dir = await project(join(tmp, "app"));
    await runStackCommand("start", ["--no-studio"], machineDeps(base, dir, { fetch }));
    await runStackCommand("start", ["--no-studio", "--tenant", "other"], machineDeps(base, tmp, { fetch }));
    await writeFile(join(base, "tenants", "other", "tenant", "vault-kek"), "kek");
    await writeFile(join(base, "tenants", "app", "tenant", "vault-kek"), "kek");
    const docker = fakeDocker();
    expect(await runStackCommand("reset", ["--yes"], machineDeps(base, dir, { docker, fetch }))).toBe(0);
    expect(docker.streamed.map((args) => args[2])).toEqual(["nylorun-app"]);
    expect(existsSync(join(base, "tenants", "app", "tenant", "vault-kek"))).toBe(false);
    expect(existsSync(join(base, "tenants", "other", "tenant", "vault-kek"))).toBe(true);

    // The Runtime creates a new Tenant after a reset: start rewrites the link.
    const before = readJson(join(dir, ".nylorun", "link.json")).tenantId;
    const fresh = machineFetch(base);
    const restart = machineDeps(base, dir, { fetch: fresh });
    await runStackCommand("start", ["--no-studio"], restart);
    const after = readJson(join(dir, ".nylorun", "link.json")).tenantId;
    expect(after).not.toBe(before);
    expect(after).toBe(fresh.tenantOf("app"));
    expect(await readFile(join(dir, ".nylorun", "credentials.json"), "utf8")).toContain(
      deriveTenantKey((readJson(join(base, "tenants", "app", "host-credentials.json")) as { adminKey: string }).adminKey, after as string, "project"),
    );
  });
});

/** A file of the machine's Studio proxy (`~/.nylorun/proxy/`). */
const proxyFile = (base: string, file: string) => readFileSync(join(base, "proxy", file), "utf8");

describe("the Studio proxy", () => {
  /** machineFetch, with Studio's login tokens answered per origin by `login`. */
  function loginFetch(base: string, login: (origin: string) => Response | undefined) {
    const machine = machineFetch(base);
    const fetch = async (url: string, init?: RequestInit) =>
      url.endsWith("/_studio/login-tokens")
        ? (login(new URL(url).origin) ?? Promise.reject(new TypeError("fetch failed")))
        : machine(url, init);
    return Object.assign(fetch, { tenantOf: machine.tenantOf });
  }
  const proxyUp = (base: string) => [
    "compose", "--project-name", "nylorun-proxy",
    "--file", join(base, "proxy", "compose.yaml"), "--env-file", join(base, "proxy", ".env"),
    "up", "--detach",
  ];
  const RELOAD = ["exec", "nylorun-proxy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"];

  it("start serves Studio at http://<name>.localhost:<port>, signed in there", async () => {
    const { tmp, base } = await machine();
    const fetch = loginFetch(base, (origin) =>
      origin === "http://default.localhost:4160" ? json({ loginUrl: "/login?token=t" }, 201) : undefined,
    );
    const docker = fakeDocker();
    const deps = machineDeps(base, tmp, { docker, fetch, interactive: true });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.lines).toContain("Studio    http://default.localhost:4160");
    const next = `next=%2Ftenants%2F${fetch.tenantOf("default")}`;
    expect(deps.opened).toEqual([`http://default.localhost:4160/login?token=t&${next}`]);

    expect(proxyFile(base, ".env")).toContain("NYLORUN_PROXY_PORT=4160\nNYLORUN_PROXY_IPV6=true\n");
    const compose = proxyFile(base, "compose.yaml");
    expect(compose).toContain("container_name: nylorun-proxy\n");
    expect(compose).toContain('dev.nylorun.proxy: "true"');
    expect(compose).toContain('- "127.0.0.1:${NYLORUN_PROXY_PORT:?run nylorun start}:80"');
    expect(compose).toContain('- "[::1]:${NYLORUN_PROXY_PORT:?run nylorun start}:80"');
    const caddyfile = proxyFile(base, "Caddyfile");
    expect(caddyfile).toContain("http://default.localhost {\n\treverse_proxy nylorun-default-studio:3000\n");
    expect(caddyfile).toContain("auto_https off");
    expect(caddyfile).toMatch(/:80 \{\n\trespond `No Tenant at \{host\}\. "nylorun ls" .*` 404/);
    const env = parseEnvLines(readFileSync(stackPaths(join(base, "tenants", "default")).env, "utf8"));
    expect(env.get("NYLORUN_STUDIO_PUBLIC_ORIGINS")).toBe("http://default.localhost:4160");
    expect(docker.calls).toEqual(
      expect.arrayContaining([proxyUp(base), ["network", "connect", "nylorun-default", "nylorun-proxy"], RELOAD]),
    );

    // `nylorun studio` signs in through the proxy too.
    const studio = machineDeps(base, tmp, { docker, fetch });
    expect(await runStackCommand("studio", ["--no-open"], studio)).toBe(0);
    expect(studio.lines.at(-1)).toBe(`Studio    http://default.localhost:4160/login?token=t&${next}`);
  });

  it("signs in on Studio's own port when the proxy does not answer, and says so", async () => {
    const { tmp, base } = await machine();
    const fetch = loginFetch(base, (origin) =>
      origin === "http://localhost:4161" ? json({ token: "t" }, 201) : json({}, 421),
    );
    const deps = machineDeps(base, tmp, { fetch, interactive: true });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.errors).toContain(
      "Studio did not answer through the proxy at http://default.localhost:4160 (Studio refused a login token (HTTP 421).); signing in at http://localhost:4161 instead.",
    );
    expect(deps.opened[0]).toMatch(/^http:\/\/localhost:4161\/login\?token=t&/);
  });

  it("routes every Tenant, joins each one's network, and start names the others running", async () => {
    const { tmp, base } = await machine();
    expect(await runStackCommand("start", [], machineDeps(base, tmp))).toBe(0);
    const docker = fakeDocker({
      respond: (args) => {
        if (args[1] === "ls")
          return { code: 0, stdout: JSON.stringify([{ Name: "nylorun-default", Status: "running(6)" }, { Name: "nylorun-two", Status: "running(6)" }]), stderr: "" };
        if (args[0] === "ps") return { code: 0, stdout: "nylorun-default-runtime\tdefault\n", stderr: "" };
        if (args[0] === "stats") return { code: 0, stdout: "nylorun-default-runtime\t1.1GiB / 8GiB\n", stderr: "" };
        return undefined;
      },
    });
    const two = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("start", ["--tenant", "two"], two)).toBe(0);
    expect(two.lines).toContain("Studio    http://two.localhost:4160");
    const caddyfile = proxyFile(base, "Caddyfile");
    expect(caddyfile).toContain("reverse_proxy nylorun-default-studio:3000");
    expect(caddyfile).toContain("reverse_proxy nylorun-two-studio:3000");
    expect(docker.calls.filter((args) => args[0] === "network")).toEqual([
      ["network", "connect", "nylorun-default", "nylorun-proxy"],
      ["network", "connect", "nylorun-two", "nylorun-proxy"],
    ]);
    expect(two.errors.at(-1)).toBe('Also running: default (about 1.2 GB). "nylorun stop --all" stops them all.');
    // Its own ports, beside default's.
    expect(readJson(join(base, "tenants", "two", "host.json")).port).toBe(50000);
  });

  it("takes a free port when 4160 is busy on its first start, and keeps it", async () => {
    const { tmp, base } = await machine();
    expect(await runStackCommand("start", [], machineDeps(base, tmp, { ports: fakePorts([4160]) }))).toBe(0);
    expect(proxyFile(base, ".env")).toContain("NYLORUN_PROXY_PORT=50000\n");
    const again = machineDeps(base, tmp);
    expect(await runStackCommand("start", [], again)).toBe(0);
    expect(again.lines).toContain("Studio    http://default.localhost:50000");
  });

  it("listens on 127.0.0.1 alone when Docker refuses [::1], and says so once", async () => {
    const { tmp, base } = await machine();
    const docker = fakeDocker({
      respond: (args) =>
        args[2] === "nylorun-proxy" && args.includes("up") && readFileSync(args[4]!, "utf8").includes("[::1]")
          ? { code: 1, stdout: "", stderr: "Error response from daemon: listen tcp6 [::1]:4160: bind: cannot assign requested address\n" }
          : undefined,
    });
    const deps = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.lines).toContain("Studio    http://default.localhost:4160");
    expect(deps.errors.filter((line) => line.includes("[::1]"))).toEqual([
      "Docker refused the Studio proxy on [::1]:4160 (Error response from daemon: listen tcp6 [::1]:4160: bind: cannot assign requested address); it listens on 127.0.0.1 only, so a browser that resolves *.localhost to ::1 alone does not reach it.",
    ]);
    expect(proxyFile(base, ".env")).toContain("NYLORUN_PROXY_IPV6=false\n");
    expect(proxyFile(base, "compose.yaml")).not.toContain("[::1]");
    const again = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("start", [], again)).toBe(0);
    expect(again.errors.filter((line) => line.includes("[::1]"))).toEqual([]);
  });

  it("never fails start: a proxy that does not come up leaves Studio on its own port", async () => {
    const { tmp, base } = await machine();
    const docker = fakeDocker({
      respond: (args) =>
        args[2] === "nylorun-proxy" ? { code: 1, stdout: "", stderr: "pull access denied\n" } : undefined,
    });
    const deps = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.lines).toContain("Studio    http://localhost:4161");
    expect(deps.errors).toContain(
      'Warning: the Studio proxy is not available (docker compose up: pull access denied); Studio is on its own port. See "nylorun doctor".',
    );
  });

  it("NYLORUN_PROXY_DISABLED=1: no proxy, Studio on its own port", async () => {
    const { tmp, base } = await machine();
    const docker = fakeDocker();
    const deps = machineDeps(base, tmp, { docker, env: { NYLORUN_PROXY_DISABLED: "1" } });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.lines).toContain("Studio    http://localhost:4161");
    expect(existsSync(join(base, "proxy"))).toBe(false);
    expect(docker.calls.some((args) => args.includes("nylorun-proxy"))).toBe(false);
    const env = parseEnvLines(readFileSync(stackPaths(join(base, "tenants", "default")).env, "utf8"));
    expect(env.get("NYLORUN_STUDIO_PUBLIC_ORIGINS")).toBe("");
  });

  it("status shows Studio through the proxy and on its own port; doctor reports the proxy", async () => {
    const { tmp, base } = await machine();
    expect(await runStackCommand("start", [], machineDeps(base, tmp))).toBe(0);
    const docker = fakeDocker({
      respond: (args) => {
        if (args.includes("ps") && args[0] === "compose")
          return { code: 0, stdout: JSON.stringify([{ Service: "studio", State: "running", Health: "healthy" }]), stderr: "" };
        if (args[0] === "inspect") return { code: 0, stdout: "running\n", stderr: "" };
        return undefined;
      },
    });
    const status = machineDeps(base, tmp, { docker });
    await runStackCommand("status", [], status);
    expect(status.lines).toContain(
      'Studio      http://default.localhost:4160  running, healthy (also http://localhost:4161; log in with "nylorun studio")',
    );
    const lines: string[] = [];
    await doctorStack({ json: false, deps: machineDeps(base, tmp, { docker }), log: (line) => lines.push(line) });
    expect(lines.join("\n")).toMatch(/proxy\s+✓ running on 127\.0\.0\.1:4160 and \[::1\]:4160/);
  });
});

describe("stop --all", () => {
  it("stops every running Tenant and the proxy, keeping volumes", async () => {
    const { tmp, base } = await machine();
    for (const name of ["default", "two", "three"])
      await runStackCommand("start", ["--no-studio", "--tenant", name], machineDeps(base, tmp));
    const docker = fakeDocker({
      respond: (args) =>
        args[1] === "ls"
          ? {
              code: 0,
              stdout: JSON.stringify([
                { Name: "nylorun-default", Status: "running(6)" },
                { Name: "nylorun-three", Status: "exited(6)" },
                { Name: "nylorun-two", Status: "exited(1), running(5)" },
                { Name: "nylorun-proxy", Status: "running(1)" },
              ]),
              stderr: "",
            }
          : undefined,
    });
    const deps = machineDeps(base, tmp, { docker });
    expect(await runStackCommand("stop", ["--all"], deps)).toBe(0);
    expect(docker.streamed.map((args) => [args[2], args.at(-1)])).toEqual([
      ["nylorun-default", "stop"],
      ["nylorun-two", "stop"],
    ]);
    expect(docker.calls).toContainEqual(["compose", "--project-name", "nylorun-proxy", "stop"]);
    expect(deps.lines).toEqual(["Stopped Tenants default, two and the Studio proxy; their data is kept."]);
    await expect(runStackCommand("stop", ["--all", "--tenant", "two"], deps)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("reset and delete with the proxy", () => {
  it("detach the proxy before Compose removes the network; delete drops the route", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", [], machineDeps(base, tmp));
    await runStackCommand("start", ["--tenant", "two"], machineDeps(base, tmp));
    const order: string[] = [];
    const docker = fakeDocker({
      respond: (args) => (order.push(args.slice(0, 3).join(" ")), undefined),
      streamCode: (args) => (order.push(`${args[2]} ${args.at(-3)}`), 0),
    });
    expect(await runStackCommand("reset", ["--yes", "--tenant", "two"], machineDeps(base, tmp, { docker }))).toBe(0);
    expect(await runStackCommand("delete", ["two", "--yes"], machineDeps(base, tmp, { docker }))).toBe(0);
    const removals = order.filter((line) => /disconnect|down/.test(line));
    expect(removals).toEqual([
      "network disconnect --force",
      "nylorun-two down",
      "network disconnect --force",
      "nylorun-two down",
    ]);
    expect(docker.calls).toContainEqual(["network", "disconnect", "--force", "nylorun-two", "nylorun-proxy"]);
    expect(proxyFile(base, "Caddyfile")).not.toContain("two.localhost");
    expect(proxyFile(base, "Caddyfile")).toContain("default.localhost");
    expect(docker.calls.at(-1)).toEqual(["exec", "nylorun-proxy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
  });
});

describe("a Tenant created by nylorun 0.5", () => {
  it("refuses to start on its old volumes; reset drops them", async () => {
    const { tmp, base } = await machine();
    await runStackCommand("start", ["--no-studio", "--tenant", "shop"], machineDeps(base, tmp));
    const docker = fakeDocker({
      respond: (args) =>
        args[0] === "volume" && args[1] === "ls"
          ? { code: 0, stdout: "nylorun-shop_postgres\nnylorun-shop_restate\nnylorun-shop_s2\nnylorun-shop-x\n", stderr: "" }
          : undefined,
    });
    const refused = runStackCommand("start", ["--tenant", "shop"], machineDeps(base, tmp, { docker }));
    await expect(refused).rejects.toMatchObject({ exitCode: 3 });
    await expect(refused).rejects.toThrow(
      'Tenant shop was created by nylorun 0.5; its data is in the old volumes nylorun-shop_postgres, nylorun-shop_restate, nylorun-shop_s2. Run "nylorun reset --tenant shop" to start it fresh',
    );
    expect(docker.streamed).toEqual([]);
    expect(await runStackCommand("reset", ["--yes", "--tenant", "shop"], machineDeps(base, tmp, { docker }))).toBe(0);
    expect(docker.calls).toContainEqual(["volume", "rm", "nylorun-shop_postgres", "nylorun-shop_restate", "nylorun-shop_s2"]);
    expect(docker.calls).toContainEqual(["network", "rm", "nylorun-shop_default"]);
  });
});
