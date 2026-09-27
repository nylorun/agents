import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureStack,
  isStackCommand,
  runStackCommand,
  runStudioCommand,
  stackProject,
  TENANT_HINT,
  tenantStudioPath,
  withNext,
} from "../../src/stack/commands.js";
import { parseComposePs } from "../../src/stack/docker.js";
import { stackPaths } from "../../src/stack/paths.js";
import { fakeDocker, fakeFetch, json, temporaryHome, testDeps } from "./support.js";

/** host.json is written during `start`, so the fakes read it lazily. */
const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;

/** A fetch that answers like a healthy stack on the persisted ports. */
async function healthyFetch(home: string, loginBody: unknown = { token: "tok en" }) {
  return fakeFetch((url) => {
    if (url.endsWith("/health"))
      return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/v1/admin/status")) return json({ tenants: [{ id: "a" }, { id: "b" }] });
    if (url.endsWith("/_studio/login-tokens")) return json(loginBody, 201);
    return undefined;
  });
}

const compose = (home: string, project = "nylorun") => [
  "compose",
  "--project-name",
  project,
  "--file",
  join(stackPaths(home).stack, "compose.yaml"),
  "--env-file",
  join(stackPaths(home).stack, ".env"),
];

describe("command names", () => {
  it("knows the six stack commands and the Compose spellings up and down", () => {
    for (const name of ["start", "stop", "status", "logs", "reset", "studio", "up", "down"])
      expect(isStackCommand(name)).toBe(true);
    expect(isStackCommand("dev")).toBe(false);
    expect(isStackCommand("tenant")).toBe(false);
    expect(isStackCommand(undefined)).toBe(false);
  });

  it("takes the Compose project from NYLORUN_STACK_PROJECT", () => {
    expect(stackProject({})).toBe("nylorun");
    expect(stackProject({ NYLORUN_STACK_PROJECT: "nylorun-f-test" })).toBe("nylorun-f-test");
    expect(() => stackProject({ NYLORUN_STACK_PROJECT: "Bad Name" })).toThrow(/NYLORUN_STACK_PROJECT/);
  });
});

describe("start", () => {
  it("writes the stack, brings up the core services, then Studio, and prints both URLs", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(docker.streamed).toEqual([
      [...compose(home), "up", "--detach", "--wait", "--wait-timeout", "300", "postgres", "restate", "s2", "runtime"],
      [...compose(home), "up", "--detach", "--wait", "--wait-timeout", "120", "studio"],
    ]);
    expect(deps.lines).toEqual([
      "Runtime   http://localhost:8787",
      "Studio    http://localhost:4161/login?token=tok%20en",
    ]);
    expect(existsSync(stackPaths(home).compose)).toBe(true);
    const login = (deps.fetch as ReturnType<typeof fakeFetch>).requests.find((r) =>
      r.url.endsWith("/_studio/login-tokens"),
    );
    expect(login?.url).toBe("http://localhost:4161/_studio/login-tokens");
    expect(login?.init?.method).toBe("POST");
    expect((login?.init?.headers as Record<string, string>).authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  it("up is start: it writes the stack on the first run and reuses it after", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    const compose = readFileSync(stackPaths(home).compose, "utf8");
    const env = readFileSync(stackPaths(home).env, "utf8");
    expect(deps.errors.some((line) => line.startsWith("Wrote "))).toBe(true);
    deps.errors.length = 0;
    expect(await runStackCommand("up", ["--no-studio"], deps)).toBe(0);
    expect(deps.errors.some((line) => line.startsWith("Wrote "))).toBe(false);
    expect(readFileSync(stackPaths(home).compose, "utf8")).toBe(compose);
    expect(readFileSync(stackPaths(home).env, "utf8")).toBe(env);
  });

  it("points to Tenant creation while the Host has no Tenant, and creates none", async () => {
    const home = await temporaryHome();
    const fetch = fakeFetch((url) => {
      if (url.endsWith("/health"))
        return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
      if (url.endsWith("/v1/admin/status")) return json({ tenants: [] });
      if (url.endsWith("/_studio/login-tokens")) return json({ token: "t" }, 201);
      return undefined;
    });
    const deps = testDeps(home, { docker: fakeDocker(), fetch });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    expect(deps.errors).toContain(TENANT_HINT);
    expect(
      fetch.requests.filter((request) => request.init?.method === "POST").map((request) => request.url),
    ).toEqual(["http://localhost:4161/_studio/login-tokens"]);

    const withTenants = testDeps(home, { docker: fakeDocker(), fetch: await healthyFetch(home) });
    await runStackCommand("up", [], withTenants);
    expect(withTenants.errors).not.toContain(TENANT_HINT);
  });

  it("uses a login URL Studio returns, and the project override", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, {
      docker,
      fetch: await healthyFetch(home, { loginUrl: "/login?token=abc" }),
      env: { NYLORUN_HOME: home, NYLORUN_STACK_PROJECT: "nylorun-f-test" },
    });
    await runStackCommand("start", [], deps);
    expect(docker.streamed[0]!.slice(0, 3)).toEqual(["compose", "--project-name", "nylorun-f-test"]);
    expect(deps.lines[1]).toBe("Studio    http://localhost:4161/login?token=abc");
  });

  it("--no-studio starts only the core services", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(docker.streamed).toHaveLength(1);
    expect(deps.lines).toEqual(["Runtime   http://localhost:8787"]);
  });

  it("warns and still succeeds when Studio does not start", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker({ streamCode: (args) => (args.includes("studio") ? 1 : 0) });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.errors.some((line) => line.startsWith("Warning: Studio did not start"))).toBe(true);
    expect(deps.lines).toEqual(["Runtime   http://localhost:8787"]);
  });

  it("warns when Studio is up but refuses a login token", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, {
      fetch: fakeFetch((url) => {
        if (url.endsWith("/health")) return json({ status: "ok", hostId: hostId(home) });
        if (url.endsWith("/_studio/login-tokens")) return json({}, 401);
        return undefined;
      }),
    });
    expect(await runStackCommand("start", [], { ...deps, loginTimeoutMs: 20 })).toBe(0);
    expect(deps.errors.some((line) => /Studio at http:\/\/localhost:4161 is not reachable/.test(line))).toBe(true);
  });

  it("fails when Compose fails or the Runtime is someone else's", async () => {
    const home = await temporaryHome();
    const failing = testDeps(home, { docker: fakeDocker({ streamCode: () => 1 }) });
    await expect(runStackCommand("start", [], failing)).rejects.toMatchObject({ exitCode: 7 });

    const foreign = testDeps(home, {
      fetch: fakeFetch((url) => (url.endsWith("/health") ? json({ status: "ok", hostId: "host_other" }) : undefined)),
    });
    await expect(runStackCommand("start", [], foreign)).rejects.toThrow(/reports Host host_other/);

    const silent = testDeps(home);
    await expect(runStackCommand("start", [], silent)).rejects.toThrow(/did not answer/);
  });

  it("refuses to start next to a running launcher-managed Runtime", async () => {
    const home = await temporaryHome();
    await mkdir(home, { recursive: true });
    await writeFile(stackPaths(home).state, JSON.stringify({ pid: 4242 }));
    const deps = testDeps(home, { pidAlive: (pid) => pid === 4242 });
    await expect(runStackCommand("start", [], deps)).rejects.toThrow(/nylorun-runtime --home .* down/);
  });

  it("rejects unknown options", async () => {
    const deps = testDeps(await temporaryHome());
    await expect(runStackCommand("start", ["--port", "1"], deps)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("Docker preflight", () => {
  it("explains a missing docker command", async () => {
    const deps = testDeps(await temporaryHome(), {
      docker: fakeDocker({
        respond: (args) => (args[0] === "version" ? { code: 127, stdout: "", stderr: "", missing: true } : undefined),
      }),
    });
    await expect(runStackCommand("start", [], deps)).rejects.toThrow(/docker command was not found/);
  });

  it("explains a stopped engine and a missing Compose v2", async () => {
    const stopped = testDeps(await temporaryHome(), {
      docker: fakeDocker({
        respond: (args) =>
          args[0] === "version" ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" } : undefined,
      }),
    });
    await expect(runStackCommand("start", [], stopped)).rejects.toThrow(/engine is not reachable \(Cannot connect/);

    const oldCompose = testDeps(await temporaryHome(), {
      docker: fakeDocker({
        respond: (args) =>
          args[1] === "version" ? { code: 0, stdout: "1.29.2\n", stderr: "" } : undefined,
      }),
    });
    await expect(runStackCommand("start", [], oldCompose)).rejects.toThrow(/Compose v2 is required.*found 1.29.2/);
  });
});

describe("stop, logs, status", () => {
  async function started() {
    const home = await temporaryHome();
    const docker = fakeDocker({
      respond: (args) =>
        args.includes("ps")
          ? {
              code: 0,
              stdout: [
                { Service: "postgres", State: "running", Health: "healthy" },
                { Service: "runtime", State: "running", Health: "healthy" },
                { Service: "studio", State: "running", Health: "healthy" },
              ]
                .map((row) => JSON.stringify(row))
                .join("\n"),
              stderr: "",
            }
          : undefined,
    });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", ["--no-studio"], deps);
    deps.lines.length = 0;
    docker.streamed.length = 0;
    return { home, docker, deps };
  }

  it("require a stack", async () => {
    const deps = testDeps(await temporaryHome());
    await expect(runStackCommand("stop", [], deps)).rejects.toMatchObject({ exitCode: 3 });
    await expect(runStackCommand("logs", [], deps)).rejects.toThrow(/nylorun start/);
  });

  it("stop runs compose stop", async () => {
    const { home, docker, deps } = await started();
    expect(await runStackCommand("stop", [], deps)).toBe(0);
    expect(docker.streamed).toEqual([[...compose(home), "stop"]]);
  });

  it("down is stop: the containers stop and the volumes stay", async () => {
    const { home, docker, deps } = await started();
    expect(await runStackCommand("down", [], deps)).toBe(0);
    expect(docker.streamed).toEqual([[...compose(home), "stop"]]);
  });

  it("logs passes the service, --follow and --tail", async () => {
    const { home, docker, deps } = await started();
    await runStackCommand("logs", ["runtime", "-f", "--tail", "20"], deps);
    await runStackCommand("logs", [], deps);
    expect(docker.streamed).toEqual([
      [...compose(home), "logs", "--follow", "--tail", "20", "runtime"],
      [...compose(home), "logs"],
    ]);
    await expect(runStackCommand("logs", ["db"], deps)).rejects.toThrow(/Unknown service db/);
    await expect(runStackCommand("logs", ["--tail", "x"], deps)).rejects.toThrow(/Invalid --tail/);
  });

  it("status reports health, Tenants and services as JSON", async () => {
    const { deps } = await started();
    expect(await runStackCommand("status", ["--json"], deps)).toBe(0);
    const status = JSON.parse(deps.lines.join("\n"));
    expect(status).toMatchObject({
      project: "nylorun",
      state: "running",
      runtime: { url: "http://localhost:8787", healthy: true, version: "0.10.0-beta", tenants: 2 },
      studio: { url: "http://localhost:4161", state: "running, healthy" },
      restate: { url: "http://localhost:9070" },
    });
    const admin = (deps.fetch as ReturnType<typeof fakeFetch>).requests.find((r) =>
      r.url.endsWith("/v1/admin/status"),
    );
    expect((admin?.init?.headers as Record<string, string>)["Nylorun-Protocol"]).toMatch(/^\d+$/);
  });

  it("status in words, and exit 3 when the Runtime does not answer", async () => {
    const { deps } = await started();
    await runStackCommand("status", [], deps);
    expect(deps.lines[0]).toBe("Stack       running (project nylorun)");
    expect(deps.lines[1]).toMatch(/^Runtime     http:\/\/localhost:8787  healthy, 0\.10\.0-beta, host_\w+, 2 Tenant\(s\)$/);
    const down = testDeps(deps.env.NYLORUN_HOME!, { docker: fakeDocker() });
    expect(await runStackCommand("status", [], down)).toBe(3);
    expect(down.lines[0]).toBe("Stack       stopped (project nylorun)");
  });

  it("status of an absent stack exits 3 without touching Docker", async () => {
    const docker = fakeDocker();
    const deps = testDeps(await temporaryHome(), { docker });
    expect(await runStackCommand("status", ["--json"], deps)).toBe(3);
    expect(JSON.parse(deps.lines[0]!).state).toBe("absent");
    expect(docker.calls).toEqual([]);
  });
});

describe("reset", () => {
  it("needs --yes when there is no terminal", async () => {
    const deps = testDeps(await temporaryHome());
    await expect(runStackCommand("reset", [], deps)).rejects.toMatchObject({ exitCode: 2 });
  });

  it("stops on a declined confirmation", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, confirm: async () => false });
    expect(await runStackCommand("reset", [], deps)).toBe(1);
    expect(docker.streamed).toEqual([]);
  });

  it("removes volumes and Tenant directories, keeping host files", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", ["--no-studio"], deps);
    const paths = stackPaths(home);
    await mkdir(join(paths.tenants, "tn_x"), { recursive: true });
    const env = await readFile(paths.env, "utf8");
    docker.streamed.length = 0;
    let asked = "";
    const confirming = { ...deps, confirm: async (q: string) => ((asked = q), true) };
    expect(await runStackCommand("reset", [], confirming)).toBe(0);
    expect(asked).toMatch(/Delete the stack's volumes/);
    expect(docker.streamed).toEqual([[...compose(home), "down", "--volumes", "--remove-orphans"]]);
    expect(existsSync(join(paths.tenants, "tn_x"))).toBe(false);
    expect(existsSync(paths.tenants)).toBe(true);
    expect(await readFile(paths.env, "utf8")).toBe(env);
    expect(existsSync(paths.credentials)).toBe(true);
  });
});

describe("studio", () => {
  it("mints a login on a running stack and opens it", async () => {
    const home = await temporaryHome();
    const psUp = {
      code: 0,
      stdout: JSON.stringify([
        { Service: "runtime", State: "running", Health: "healthy" },
        { Service: "studio", State: "running", Health: "healthy" },
      ]),
      stderr: "",
    };
    const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : undefined) });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", [], deps);
    docker.streamed.length = 0;
    deps.lines.length = 0;
    expect(await runStackCommand("studio", [], deps)).toBe(0);
    expect(docker.streamed).toEqual([]);
    expect(deps.lines).toEqual(["Studio    http://localhost:4161/login?token=tok%20en"]);
    expect(deps.opened).toEqual(["http://localhost:4161/login?token=tok%20en"]);
  });

  it("starts a stopped stack first; --no-open only prints", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("studio", ["--no-open"], deps)).toBe(0);
    expect(docker.streamed.map((args) => args.at(-1))).toEqual(["runtime", "studio"]);
    expect(deps.lines).toEqual([
      "Runtime   http://localhost:8787",
      "Studio    http://localhost:4161/login?token=tok%20en",
    ]);
    expect(deps.opened).toEqual([]);
  });

  it("lands on a Tenant page when given one", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    const next = tenantStudioPath("tn_01TESTSTUDIO00000000000001");
    expect(await runStudioCommand([], deps, { next })).toBe(0);
    const expected =
      "http://localhost:4161/login?token=tok+en&next=%2Ftenants%2Ftn_01TESTSTUDIO00000000000001";
    expect(deps.lines.at(-1)).toBe(`Studio    ${expected}`);
    expect(deps.opened).toEqual([expected]);
    const url = new URL(expected);
    expect(url.searchParams.get("token")).toBe("tok en");
    expect(url.searchParams.get("next")).toBe("/tenants/tn_01TESTSTUDIO00000000000001");
  });

  it("withNext keeps the login URL when there is no next", () => {
    expect(withNext("http://localhost:1/login?token=a", undefined)).toBe(
      "http://localhost:1/login?token=a",
    );
  });

  it("fails when Studio cannot start", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker({ streamCode: (args) => (args.includes("studio") ? 1 : 0) });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await expect(runStackCommand("studio", ["--no-open"], deps)).rejects.toMatchObject({ exitCode: 7 });
  });
});

describe("ensureStack", () => {
  it("reuses a running stack without Compose up", async () => {
    const home = await temporaryHome();
    const psUp = {
      code: 0,
      stdout: JSON.stringify([
        { Service: "runtime", State: "running", Health: "healthy" },
        { Service: "studio", State: "running", Health: "healthy" },
      ]),
      stderr: "",
    };
    const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : undefined) });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", [], deps);
    docker.streamed.length = 0;
    deps.lines.length = 0;
    const stack = await ensureStack(deps, { studio: true });
    expect(docker.streamed).toEqual([]);
    expect(deps.lines).toEqual([]);
    expect(stack).toMatchObject({
      home,
      runtimeUrl: "http://localhost:8787",
      hostId: hostId(home),
      studioPort: 4161,
      studioUp: true,
      started: false,
    });
    expect(stack.adminKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("starts a stopped stack quietly; without Studio only the core services", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    const stack = await ensureStack(deps, { studio: false });
    expect(docker.streamed.map((args) => args.at(-1))).toEqual(["runtime"]);
    expect(deps.lines).toEqual([]);
    expect(stack).toMatchObject({ started: true, studioUp: false, runtimeUrl: "http://localhost:8787" });
  });

  it("checks Docker first", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker({
      respond: (args) =>
        args[0] === "version" ? { code: 127, stdout: "", stderr: "", missing: true } : undefined,
    });
    await expect(ensureStack(testDeps(home, { docker }), { studio: true })).rejects.toThrow(
      /Docker Desktop, OrbStack, Colima/,
    );
  });
});

describe("parseComposePs", () => {
  it("reads both the array and the line-per-service formats", () => {
    const row = { Service: "runtime", State: "running", Health: "healthy" };
    const expected = [{ service: "runtime", state: "running", health: "healthy" }];
    expect(parseComposePs(JSON.stringify([row]))).toEqual(expected);
    expect(parseComposePs(`${JSON.stringify(row)}\n`)).toEqual(expected);
    expect(parseComposePs("")).toEqual([]);
  });
});
