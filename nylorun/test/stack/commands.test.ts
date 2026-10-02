import { doctorStack } from "../../src/doctor.js";
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
  STUDIO_SIGN_IN_HINT,
  tenantStudioPath,
  withNext,
} from "../../src/stack/commands.js";
import { parseComposePs } from "../../src/stack/docker.js";
import { stackPaths } from "../../src/stack/paths.js";
import { fakeDocker, fakeFetch, json, temporaryHome, testDeps } from "./support.js";

/** host.json is written during `start`, so the fakes read it lazily. */
const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;

const TENANT_ID = "tn_01TESTSTACK000000000000001";

/** `/v1/admin/status` of a stack whose Tenant is open. */
const openTenant = (name = "home-root") =>
  json({ tenant: { id: TENANT_ID, name, state: "open", envelope: null } });

/** A fetch that answers like a healthy stack on the persisted ports. */
async function healthyFetch(home: string, loginBody: unknown = { token: "tok en" }) {
  return fakeFetch((url) => {
    if (url.endsWith("/health"))
      return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/v1/admin/status")) return openTenant();
    if (url.endsWith("/_studio/login-tokens")) return json(loginBody, 201);
    return undefined;
  });
}

/** What `start` prints for the stack under `home`. */
const startLines = (home: string, studio = true) => [
  `Stack     home-root  (${home})`,
  `Tenant    ${TENANT_ID}  (home-root)`,
  "Runtime   http://localhost:8787",
  ...(studio ? ["Studio    http://localhost:4161"] : []),
];

const NEXT = `next=%2Ftenants%2F${TENANT_ID}`;

const compose = (home: string, project = "nylorun-home-root") => [
  "compose",
  "--project-name",
  project,
  "--file",
  join(stackPaths(home).stack, "compose.yaml"),
  "--env-file",
  join(stackPaths(home).stack, ".env"),
];

describe("command names", () => {
  it("knows the stack commands and the Compose spellings up and down", () => {
    for (const name of ["start", "stop", "status", "logs", "reset", "studio", "up", "down", "ls", "delete", "legacy"])
      expect(isStackCommand(name)).toBe(true);
    expect(isStackCommand("dev")).toBe(false);
    expect(isStackCommand("tenant")).toBe(false);
    expect(isStackCommand(undefined)).toBe(false);
  });

  it("names the Compose project after the stack, unless NYLORUN_STACK_PROJECT overrides it", () => {
    expect(stackProject({}, "shop")).toBe("nylorun-shop");
    expect(stackProject({ NYLORUN_STACK_PROJECT: "nylorun-f-test" }, "shop")).toBe("nylorun-f-test");
    expect(() => stackProject({ NYLORUN_STACK_PROJECT: "Bad Name" }, "shop")).toThrow(/NYLORUN_STACK_PROJECT/);
  });
});

describe("start", () => {
  it("writes the stack, brings up the core services, then Studio, and prints both URLs", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(docker.streamed).toEqual([
      [...compose(home), "up", "--detach", "--wait", "--wait-timeout", "300", "postgres", "restate", "s2", "gateway", "runtime"],
      [...compose(home), "up", "--detach", "--wait", "--wait-timeout", "120", "studio"],
    ]);
    expect(deps.lines).toEqual(startLines(home));
    expect(existsSync(stackPaths(home).compose)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "stack.json"), "utf8"))).toEqual({ format: 1, name: "home-root" });
  });

  it("outside a terminal, mints no login and says how to sign in", async () => {
    const home = await temporaryHome();
    const fetch = await healthyFetch(home);
    const deps = testDeps(home, { fetch });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    expect(deps.opened).toEqual([]);
    expect(deps.errors).toContain(STUDIO_SIGN_IN_HINT);
    expect(fetch.requests.some((r) => r.url.endsWith("/_studio/login-tokens"))).toBe(false);
  });

  it("in a terminal, opens Studio signed in and prints no token", async () => {
    const home = await temporaryHome();
    const fetch = await healthyFetch(home);
    const deps = testDeps(home, { fetch, interactive: true });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    expect(deps.lines).toEqual(startLines(home));
    expect(deps.opened).toEqual([`http://localhost:4161/login?token=tok+en&${NEXT}`]);
    expect(deps.errors).not.toContain(STUDIO_SIGN_IN_HINT);
    const login = fetch.requests.find((r) => r.url.endsWith("/_studio/login-tokens"));
    expect(login?.url).toBe("http://localhost:4161/_studio/login-tokens");
    expect(login?.init?.method).toBe("POST");
    expect((login?.init?.headers as Record<string, string>).authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  it("opens no browser with --no-open or in CI", async () => {
    const home = await temporaryHome();
    const noOpen = testDeps(home, { fetch: await healthyFetch(home), interactive: true });
    expect(await runStackCommand("up", ["--no-open"], noOpen)).toBe(0);
    expect(noOpen.opened).toEqual([]);
    expect(noOpen.errors).toContain(STUDIO_SIGN_IN_HINT);
    const ci = testDeps(home, {
      fetch: await healthyFetch(home),
      interactive: true,
      env: { NYLORUN_HOME: home, CI: "true" },
    });
    expect(await runStackCommand("up", [], ci)).toBe(0);
    expect(ci.opened).toEqual([]);
  });

  it("prints the login URL when no browser starts", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, {
      fetch: await healthyFetch(home),
      interactive: true,
      openBrowser: async () => false,
    });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    expect(deps.lines).toEqual([
      ...startLines(home),
      `Sign in   http://localhost:4161/login?token=tok+en&${NEXT}`,
    ]);
  });

  it("up is start: it writes the stack on the first run and reuses it after", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("up", [], deps)).toBe(0);
    const compose = readFileSync(stackPaths(home).compose, "utf8");
    const env = readFileSync(stackPaths(home).env, "utf8");
    expect(deps.errors.some((line) => line.startsWith("Created stack home-root "))).toBe(true);
    deps.errors.length = 0;
    expect(await runStackCommand("up", ["--no-studio"], deps)).toBe(0);
    expect(deps.errors.some((line) => line.startsWith("Created stack"))).toBe(false);
    expect(readFileSync(stackPaths(home).compose, "utf8")).toBe(compose);
    expect(readFileSync(stackPaths(home).env, "utf8")).toBe(env);
  });

  it("waits for the stack's Tenant to open, and creates nothing itself", async () => {
    const home = await temporaryHome();
    let polls = 0;
    const fetch = fakeFetch((url) => {
      if (url.endsWith("/health"))
        return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
      if (url.endsWith("/v1/admin/status"))
        return (polls += 1) < 3
          ? json({ tenant: { id: null, name: null, state: "unavailable", envelope: null } })
          : openTenant();
      return undefined;
    });
    const deps = testDeps(home, { fetch });
    expect(await runStackCommand("up", ["--no-studio"], deps)).toBe(0);
    expect(polls).toBe(3);
    expect(deps.lines).toEqual(startLines(home, false));
    const admin = fetch.requests.find((r) => r.url.endsWith("/v1/admin/status"))!;
    expect(admin.url).toBe("http://localhost:8788/v1/admin/status");
    expect((admin.init?.headers as Record<string, string>)["Nylorun-Protocol"]).toBe("5");
    expect(fetch.requests.filter((request) => request.init?.method === "POST")).toEqual([]);
  });

  it("reports why the Tenant is unavailable (exit 7)", async () => {
    const home = await temporaryHome();
    const unavailable = json({
      tenant: {
        id: TENANT_ID,
        name: "home-root",
        state: "unavailable",
        envelope: null,
        cause: { code: "kek-missing", message: "The vault key is missing.", repair: "Restore tenant/vault-kek." },
      },
    });
    const fetch = fakeFetch((url) => {
      if (url.endsWith("/health")) return json({ status: "ok", hostId: hostId(home) });
      if (url.endsWith("/v1/admin/status")) return unavailable.clone();
      return undefined;
    });
    const started = runStackCommand("up", ["--no-studio"], testDeps(home, { fetch }));
    await expect(started).rejects.toMatchObject({ exitCode: 7 });
    await expect(started).rejects.toThrow(
      /Tenant of stack home-root is unavailable \(kek-missing\): The vault key is missing\. Restore tenant\/vault-kek\./,
    );
    // The Runtime fails readiness, so Compose fails first: the cause is reported all the same.
    const composeFails = testDeps(home, { fetch, docker: fakeDocker({ streamCode: () => 1 }) });
    await expect(runStackCommand("up", [], composeFails)).rejects.toThrow(/unavailable \(kek-missing\)/);
  });

  it("uses a login URL Studio returns, and the project override", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, {
      docker,
      fetch: await healthyFetch(home, { loginUrl: "/login?token=abc" }),
      env: { NYLORUN_HOME: home, NYLORUN_STACK_PROJECT: "nylorun-f-test" },
      interactive: true,
    });
    await runStackCommand("start", [], deps);
    expect(docker.streamed[0]!.slice(0, 3)).toEqual(["compose", "--project-name", "nylorun-f-test"]);
    expect(deps.opened).toEqual([`http://localhost:4161/login?token=abc&${NEXT}`]);
  });

  it("--no-studio starts only the core services", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(docker.streamed).toHaveLength(1);
    expect(deps.lines).toEqual(startLines(home, false));
  });

  it("warns and still succeeds when Studio does not start", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker({ streamCode: (args) => (args.includes("studio") ? 1 : 0) });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", [], deps)).toBe(0);
    expect(deps.errors.some((line) => line.startsWith("Warning: Studio did not start"))).toBe(true);
    expect(deps.lines).toEqual(startLines(home, false));
  });

  it("warns when Studio is up but refuses a login token", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, {
      interactive: true,
      fetch: fakeFetch((url) => {
        if (url.endsWith("/health")) return json({ status: "ok", hostId: hostId(home) });
        if (url.endsWith("/v1/admin/status")) return openTenant();
        if (url.endsWith("/_studio/login-tokens")) return json({}, 401);
        return undefined;
      }),
    });
    expect(await runStackCommand("start", [], { ...deps, loginTimeoutMs: 20 })).toBe(0);
    expect(deps.errors.some((line) => /Studio at http:\/\/localhost:4161 is not reachable/.test(line))).toBe(true);
    expect(deps.opened).toEqual([]);
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

describe("start never runs a Runtime older than the stack's database", () => {
  const recorded = (home: string) =>
    (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { runtimeVersion?: string })
      .runtimeVersion;

  /** A healthy stack whose Runtime reports `version`. */
  const runningFetch = (home: string, version: string) =>
    fakeFetch((url) => {
      if (url.endsWith("/health")) return json({ status: "ok", version, hostId: hostId(home) });
      if (url.endsWith("/v1/admin/status")) return openTenant();
      return undefined;
    });

  /** Start the stack once with an earlier nylorun pinning `version`. */
  async function startedBy(version: string) {
    const home = await temporaryHome();
    const first = testDeps(home, { fetch: runningFetch(home, version), runtimeVersion: version });
    expect(await runStackCommand("start", ["--no-studio"], first)).toBe(0);
    return home;
  }

  it("--studio-embed-origin adds an origin that may frame Studio, and status reports it", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, { fetch: await healthyFetch(home) });
    expect(
      await runStackCommand(
        "start",
        ["--no-studio", "--studio-embed-origin", "http://localhost:1420"],
        deps,
      ),
    ).toBe(0);
    const env = readFileSync(stackPaths(home).env, "utf8");
    expect(env).toContain(
      "NYLORUN_STUDIO_FRAME_ANCESTORS='nylorun://localhost http://nylorun.localhost http://localhost:1420'",
    );
    await expect(
      runStackCommand("start", ["--no-studio", "--studio-embed-origin", "*"], deps),
    ).rejects.toThrow(/not an exact origin/);
    await expect(
      runStackCommand("start", ["--no-studio", "--studio-embed-origin"], deps),
    ).rejects.toThrow(/requires a value/);
  });

  it("records the pinned Runtime on the first run", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, { fetch: await healthyFetch(home) });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(recorded(home)).toBe("0.10.0-beta");
    expect(deps.errors.some((line) => /downgrad/i.test(line))).toBe(false);
  });

  it("starts the same version again", async () => {
    const home = await startedBy("0.10.0-beta");
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: runningFetch(home, "0.10.0-beta") });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(docker.streamed).toHaveLength(1);
    expect(recorded(home)).toBe("0.10.0-beta");
  });

  it("upgrades a stack that ran, or is running, an older Runtime", async () => {
    const home = await startedBy("0.9.0-beta");
    expect(recorded(home)).toBe("0.9.0-beta");
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: runningFetch(home, "0.9.0-beta") });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(docker.streamed).toHaveLength(1);
    expect(recorded(home)).toBe("0.10.0-beta");
    expect(readFileSync(stackPaths(home).env, "utf8")).toContain("ghcr.io/nylorun/runtime:0.10.0-beta");
  });

  it("refuses a Runtime older than host.json records, before touching the stack", async () => {
    const home = await startedBy("0.10.0");
    const env = readFileSync(stackPaths(home).env, "utf8");
    // 0.10.0-beta is a prerelease of 0.10.0, so it is older.
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: fakeFetch(() => undefined) });
    const refused = runStackCommand("up", [], deps);
    await expect(refused).rejects.toMatchObject({ exitCode: 5 });
    await expect(refused).rejects.toThrow(
      /Refusing to start Runtime 0\.10\.0-beta on stack home-root: Runtime 0\.10\.0 last ran it .*npx nylorun@latest start.*--allow-downgrade/,
    );
    expect(docker.streamed).toEqual([]);
    expect(recorded(home)).toBe("0.10.0");
    expect(readFileSync(stackPaths(home).env, "utf8")).toBe(env);

    // `nylorun studio` starts the stack through the same path.
    await expect(runStudioCommand(["--no-open"], deps)).rejects.toMatchObject({ exitCode: 5 });
    expect(docker.streamed).toEqual([]);
  });

  it("downgrades with --allow-downgrade, warns, and records the older Runtime", async () => {
    const home = await startedBy("0.11.0-beta");
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: runningFetch(home, "0.11.0-beta") });
    expect(await runStackCommand("start", ["--no-studio", "--allow-downgrade"], deps)).toBe(0);
    expect(docker.streamed).toHaveLength(1);
    expect(deps.errors).toContain(
      "Warning: starting Runtime 0.10.0-beta on stack home-root, which Runtime 0.11.0-beta last ran. " +
        "If that Runtime migrated the database, the Tenant stays unavailable (schema-too-new).",
    );
    expect(recorded(home)).toBe("0.10.0-beta");
    expect(readFileSync(stackPaths(home).env, "utf8")).toContain("ghcr.io/nylorun/runtime:0.10.0-beta");
  });

  it("does not guard, or record a version for, an image named by NYLORUN_RUNTIME_IMAGE", async () => {
    const home = await startedBy("0.11.0-beta");
    const deps = testDeps(home, {
      env: { NYLORUN_HOME: home, NYLORUN_RUNTIME_IMAGE: "nylorun-runtime:dev" },
      fetch: runningFetch(home, "0.11.0-beta"),
    });
    expect(await runStackCommand("start", ["--no-studio"], deps)).toBe(0);
    expect(recorded(home)).toBe("0.11.0-beta");
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
                { Service: "gateway", State: "running", Health: "healthy" },
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

  it("status reports the stack, its Tenant, health and services as JSON", async () => {
    const { home, deps } = await started();
    expect(await runStackCommand("status", ["--json"], deps)).toBe(0);
    const status = JSON.parse(deps.lines.join("\n"));
    expect(status).toMatchObject({
      name: "home-root",
      project: "nylorun-home-root",
      home,
      state: "running",
      runtime: { url: "http://localhost:8787", healthy: true, version: "0.10.0-beta" },
      tenant: { id: TENANT_ID, name: "home-root", state: "open" },
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
    expect(deps.lines.slice(0, 4)).toEqual([
      "Stack       home-root running (Compose project nylorun-home-root)",
      `Host root   ${deps.env.NYLORUN_HOME} (admin key in host-credentials.json, mode 0600)`,
      `Tenant      ${TENANT_ID} (home-root)  open`,
      expect.stringMatching(/^Runtime     http:\/\/localhost:8787  healthy, 0\.10\.0-beta, host_\w+$/),
    ]);
    const down = testDeps(deps.env.NYLORUN_HOME!, { docker: fakeDocker() });
    expect(await runStackCommand("status", [], down)).toBe(3);
    expect(down.lines[0]).toBe("Stack       home-root stopped (Compose project nylorun-home-root)");
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

  it("removes the volumes and the Tenant directory, keeping host files", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", ["--no-studio"], deps);
    const paths = stackPaths(home);
    await writeFile(join(paths.tenant, "vault-kek"), "kek");
    // `start` wrote the vault key beside the Tenant directory (F4.2); reset deletes it too.
    expect(existsSync(paths.vaultKey)).toBe(true);
    const env = await readFile(paths.env, "utf8");
    docker.streamed.length = 0;
    let asked = "";
    const confirming = { ...deps, confirm: async (q: string) => ((asked = q), true) };
    expect(await runStackCommand("reset", [], confirming)).toBe(0);
    expect(asked).toMatch(/Delete stack home-root's volumes \(Compose project nylorun-home-root\)/);
    expect(docker.streamed).toEqual([[...compose(home), "down", "--volumes", "--remove-orphans"]]);
    expect(existsSync(join(paths.tenant, "vault-kek"))).toBe(false);
    expect(existsSync(paths.vaultKey)).toBe(false);
    expect(existsSync(paths.tenant)).toBe(true);
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
        { Service: "gateway", State: "running", Health: "healthy" },
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
    expect(deps.lines).toEqual([`Studio    http://localhost:4161/tenants/${TENANT_ID}`]);
    expect(deps.opened).toEqual([`http://localhost:4161/login?token=tok+en&${NEXT}`]);
  });

  it("starts a stopped stack first; --no-open only prints", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    expect(await runStackCommand("studio", ["--no-open"], deps)).toBe(0);
    expect(docker.streamed.map((args) => args.at(-1))).toEqual(["runtime", "studio"]);
    expect(deps.lines).toEqual([
      "Runtime   http://localhost:8787",
      `Studio    http://localhost:4161/login?token=tok+en&${NEXT}`,
    ]);
    expect(deps.opened).toEqual([]);
  });

  it("lands on the page it is given", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    const next = tenantStudioPath("tn_01TESTSTUDIO00000000000001");
    expect(await runStudioCommand([], deps, { next })).toBe(0);
    const expected =
      "http://localhost:4161/login?token=tok+en&next=%2Ftenants%2Ftn_01TESTSTUDIO00000000000001";
    expect(deps.lines.at(-1)).toBe("Studio    http://localhost:4161/tenants/tn_01TESTSTUDIO00000000000001");
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
        { Service: "gateway", State: "running", Health: "healthy" },
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
      name: "home-root",
      home,
      runtimeUrl: "http://localhost:8787",
      adminUrl: "http://localhost:8788",
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

describe("doctor with a running stack", () => {
  it.each([
    ["healthy", 0, /gateway\s+✓ running, healthy · combined packing/],
    ["unhealthy", 1, /gateway\s+✗ running, unhealthy: model calls fail; see nylorun logs gateway/],
  ] as const)("reports a %s gateway (exit %i)", async (health, code, line) => {
    const home = await temporaryHome();
    const docker = fakeDocker({
      respond: (args) =>
        args.includes("ps")
          ? {
              code: 0,
              stdout: JSON.stringify([
                { Service: "gateway", State: "running", Health: health },
                { Service: "runtime", State: "running", Health: "healthy" },
                { Service: "studio", State: "running", Health: "healthy" },
              ]),
              stderr: "",
            }
          : undefined,
    });
    const deps = testDeps(home, { docker, fetch: await healthyFetch(home) });
    await runStackCommand("start", ["--no-studio"], deps);
    const lines: string[] = [];
    expect(await doctorStack({ json: false, deps, log: (text) => lines.push(text) })).toBe(code);
    expect(lines.join("\n")).toMatch(line);
  });
});
