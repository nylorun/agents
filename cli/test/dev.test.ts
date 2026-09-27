import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachOptions } from "../src/project/attach.js";

const homeRef = { value: "" };
const tenantId = "tn_01TESTDEV0000000000000001";
const hostId = "host_01habcdefghijklmnopqrstuv";
const calls = {
  ensure: [] as { studio: boolean }[],
  attach: [] as AttachOptions[],
  login: [] as (string | undefined)[],
  opened: [] as string[],
};

vi.mock("../src/stack/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/stack/index.js")>(
    "../src/stack/index.js",
  );
  return {
    ...actual,
    defaultStackDeps: () => ({
      openBrowser: async (url: string) => {
        calls.opened.push(url);
      },
      err: () => {},
    }),
    ensureStack: async (_deps: unknown, options: { studio: boolean }) => {
      calls.ensure.push(options);
      return {
        home: homeRef.value,
        runtimeUrl: "http://localhost:8787",
        hostId,
        adminKey: "cd".repeat(32),
        studioPort: 4161,
        studioUp: options.studio,
        started: true,
      };
    },
    studioLoginUrl: async (_deps: unknown, _stack: unknown, next?: string) => {
      calls.login.push(next);
      return `http://localhost:4161/login?token=tok&next=${encodeURIComponent(next ?? "/")}`;
    },
  };
});

vi.mock("../src/project/attach.js", async () => {
  const actual = await vi.importActual<typeof import("../src/project/attach.js")>(
    "../src/project/attach.js",
  );
  return {
    ...actual,
    attachProject: async (options: AttachOptions) => {
      calls.attach.push(options);
      return {
        projectRoot: options.projectRoot,
        link: { format: 1 as const, hostUrl: options.host.url, hostId, tenantId },
        credentials: {
          format: 1 as const,
          applicationKey: "ab".repeat(32),
          principalId: "pr_test",
        },
        tenantName: "dev-demo",
        created: true,
        hostStarted: options.host.started,
        home: options.host.home,
      };
    },
  };
});

const seeds: Record<string, unknown>[] = [];
const seedFailure: { error?: Error } = {};
vi.mock("../src/project/seed.js", () => ({
  seedTenantFromProject: async (options: Record<string, unknown>) => {
    seeds.push(options);
    if (seedFailure.error) throw seedFailure.error;
    return { applied: [], kept: [] };
  },
}));

import type { Admin } from "@nylorun/admin";
import {
  develop,
  developmentPreflight,
  LOCAL_UI_REMOVED,
} from "../src/dev.js";
import type { StackDeps } from "../src/stack/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    [...roots.splice(0), homeRef.value].filter(Boolean).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  homeRef.value = await realpath(await mkdtemp(join(tmpdir(), "nylorun-home-")));
  for (const list of Object.values(calls)) list.length = 0;
  seeds.length = 0;
  delete seedFailure.error;
});

async function fixture(app = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-dev-")));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module","name":"dev-demo"}');
  if (app) {
    await mkdir(join(root, "node_modules/tsx"), { recursive: true });
    await writeFile(
      join(root, "node_modules/tsx/package.json"),
      '{"type":"module","exports":{"./cli":"./cli.js"}}',
    );
    await writeFile(
      join(root, "node_modules/tsx/cli.js"),
      `
import {writeFileSync} from 'node:fs';
writeFileSync('app.json', JSON.stringify({
  args: process.argv.slice(2),
  env: {
    url: process.env.NYLORUN_RUNTIME_URL,
    tenant: process.env.NYLORUN_TENANT,
    key: process.env.NYLORUN_SERVER_KEY,
  },
}));
process.on('SIGTERM',()=>{ try { writeFileSync('app-stopped','yes'); } catch {} process.exit(0); });
process.on('SIGINT',()=>{ try { writeFileSync('app-stopped','yes'); } catch {} process.exit(0); });
setInterval(()=>{}, 1000);
`,
    );
  }
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), `console.log("main");\n`);
  return root;
}

async function runCli(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, NYLORUN_HOME: homeRef.value },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", (value) => resolve(value)),
  );
  return { code, output };
}

async function withCwd<T>(dir: string, run: () => T): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

it("F2-1: preflight requires tsx; Studio flags", async () => {
  const bare = await fixture(false);
  await withCwd(bare, () => expect(() => developmentPreflight([])).toThrow("Install tsx"));
  const root = await fixture(true);
  await withCwd(root, () => {
    expect(developmentPreflight([])).toMatchObject({
      entry: "src/main.ts",
      ephemeral: false,
      studio: true,
      open: true,
    });
    expect(developmentPreflight(["agents/index.ts"]).entry).toBe("agents/index.ts");
    expect(developmentPreflight(["--no-open"])).toMatchObject({ studio: true, open: false });
    expect(developmentPreflight(["--no-studio"])).toMatchObject({ studio: false, open: false });
    expect(() => developmentPreflight(["--local-ui"])).toThrow(LOCAL_UI_REMOVED);
    expect(() => developmentPreflight(["--no-open", "--no-open"])).toThrow("Usage");
  });
});

it("rejects removed --global and --local-ui via the CLI", async () => {
  const root = await fixture();
  const global = await runCli(["dev", "--global"], root);
  expect(global.code).toBe(2);
  expect(global.output).toContain("--global was removed");
  const localUi = await runCli(["studio", "--local-ui"], root);
  expect(localUi.code).toBe(2);
  expect(localUi.output).toContain("--local-ui was removed");
});

it("removed launcher commands point at the stack commands", async () => {
  const root = await fixture();
  for (const [args, replacement] of [
    [["runtime", "up"], "nylorun start"],
    [["runtime", "down"], "nylorun stop"],
    [["runtime", "status"], "nylorun status"],
    [["runtime", "logs"], "nylorun logs"],
    [["runtime"], "nylorun start|stop|status|logs"],
    [["up"], "nylorun start"],
    [["down"], "nylorun stop"],
  ] as const) {
    const result = await runCli([...args], root);
    expect(result.code).toBe(2);
    expect(result.output).toContain("was removed");
    expect(result.output).toContain(`Use ${replacement}`);
  }
});

it("F2-5: serve command remains removed", async () => {
  const root = await fixture();
  const serve = await runCli(["serve"], root);
  expect(serve.code).toBe(2);
  expect(serve.output).toMatch(/removed/);
});

async function runDevelop(
  root: string,
  flags: string[],
  extra: Partial<Parameters<typeof develop>[0]> & {
    /** Runs once the application started, instead of killing it. */
    whileRunning?: () => void;
  } = {},
) {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const { whileRunning, ...options } = extra;
  const runPromise = develop({ projectRoot: root, flags, ...options });
  let code: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const tick = async () => {
        try {
          await readFile(join(root, "app.json"), "utf8");
          resolve();
        } catch (error) {
          if (Date.now() > deadline) reject(error);
          else setTimeout(tick, 50);
        }
      };
      void tick();
    });
    whileRunning?.();
  } finally {
    console.log = original;
    if (!whileRunning) {
      const { execSync } = await import("node:child_process");
      try {
        execSync(`pkill -f ${JSON.stringify(join(root, "node_modules/tsx/cli.js"))} || true`);
      } catch {
        /* ignore */
      }
    }
    code = await Promise.race([runPromise, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
  const app = JSON.parse(await readFile(join(root, "app.json"), "utf8")) as {
    args: string[];
    env: { url: string; tenant: string; key: string };
  };
  return { logs, app, code };
}

it(
  "F2-1: develop starts the stack, attaches the Project, opens Studio on its Tenant and runs tsx watch",
  { timeout: 15_000 },
  async () => {
    const root = await fixture();
    const { logs, app } = await runDevelop(root, []);
    expect(calls.ensure).toEqual([{ studio: true }]);
    expect(calls.attach[0]).toMatchObject({
      projectRoot: root,
      host: { home: homeRef.value, url: "http://localhost:8787", hostId, started: true },
    });
    expect(app.args).toContain("watch");
    expect(app.args.some((arg) => arg.endsWith("src/main.ts"))).toBe(true);
    expect(app.env).toEqual({
      url: "http://localhost:8787",
      tenant: tenantId,
      key: "ab".repeat(32),
    });
    expect(calls.login).toEqual([`/tenants/${tenantId}`]);
    const studioUrl = `http://localhost:4161/login?token=tok&next=${encodeURIComponent(`/tenants/${tenantId}`)}`;
    expect(calls.opened).toEqual([studioUrl]);
    expect(logs).toContain(`Studio        ${studioUrl}`);
    expect(logs.some((line) => line.includes("(started; stays running)"))).toBe(true);
    expect(logs.some((line) => line.includes("(created)"))).toBe(true);
    expect(logs.some((line) => line.includes("nylorun stop stops the stack"))).toBe(true);
  },
);

it(
  "dev --no-open prints the Studio login without opening it; --no-studio skips Studio",
  { timeout: 20_000 },
  async () => {
    const root = await fixture();
    const noOpen = await runDevelop(root, ["--no-open"]);
    expect(calls.opened).toEqual([]);
    expect(noOpen.logs.some((line) => line.startsWith("Studio        http://localhost:4161/login"))).toBe(true);

    const other = await fixture();
    for (const list of Object.values(calls)) list.length = 0;
    const noStudio = await runDevelop(other, ["--no-studio"]);
    expect(calls.ensure).toEqual([{ studio: false }]);
    expect(calls.login).toEqual([]);
    expect(calls.opened).toEqual([]);
    expect(noStudio.logs.some((line) => line.startsWith("Studio"))).toBe(false);
  },
);

const EPHEMERAL_ID = "tn_01TESTEPHEMERAL00000000001";

/** A fake Admin API client and stack dependencies for `--ephemeral`. */
function ephemeralFakes(options: { features?: string[] } = {}) {
  const admin = {
    created: [] as string[],
    deleted: [] as { id: string; activeWork?: string }[],
  };
  const errors: string[] = [];
  const client = {
    url: "http://localhost:8787",
    source: "local-host",
    createTenant: async ({ name }: { name: string }) => {
      admin.created.push(name);
      const now = new Date().toISOString();
      return {
        tenant: { id: EPHEMERAL_ID, name, createdAt: now, updatedAt: now, schemaVersion: 1 },
        applicationKey: "ef".repeat(32),
      };
    },
    deleteTenant: async (id: string, opts?: { activeWork?: string }) => {
      admin.deleted.push({ id, ...(opts?.activeWork ? { activeWork: opts.activeWork } : {}) });
    },
  } as unknown as Admin;
  const deps = {
    fetch: async (url: string) => {
      expect(url).toBe("http://localhost:8787/health");
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "0.10.0-beta",
          protocol: {
            min: 2,
            max: 2,
            features: options.features ?? ["runtime-tenants", "tenant-fixture-model"],
          },
        }),
      );
    },
    openBrowser: async (url: string) => {
      calls.opened.push(url);
    },
    err: (line: string) => errors.push(line),
  } as unknown as StackDeps;
  return { admin, client, deps, errors };
}

it(
  "dev --ephemeral runs the watcher on a temporary fixture-model Tenant and deletes it on exit",
  { timeout: 15_000 },
  async () => {
    const root = await fixture();
    const fakes = ephemeralFakes();
    const homes: string[] = [];
    const { logs, app } = await runDevelop(root, ["--ephemeral"], {
      stack: fakes.deps,
      admin: (home) => {
        homes.push(home);
        return fakes.client;
      },
    });
    expect(calls.ensure).toEqual([{ studio: true }]);
    expect(homes).toEqual([homeRef.value]);
    // No Project link: the Project's own Tenant is never attached or created.
    expect(calls.attach).toEqual([]);
    await expect(readFile(join(root, ".nylorun/link.json"), "utf8")).rejects.toThrow();
    expect(fakes.admin.created).toEqual(["dev-demo (ephemeral)"]);
    expect(seeds).toEqual([
      expect.objectContaining({
        hostUrl: "http://localhost:8787",
        tenantId: EPHEMERAL_ID,
        applicationKey: "ef".repeat(32),
        projectRoot: root,
        fixtureModel: true,
      }),
    ]);
    expect(app.env).toEqual({
      url: "http://localhost:8787",
      tenant: EPHEMERAL_ID,
      key: "ef".repeat(32),
    });
    expect(calls.login).toEqual([`/tenants/${EPHEMERAL_ID}`]);
    expect(logs.some((line) => line.includes("(temporary, fixture model; deleted on exit)"))).toBe(
      true,
    );
    expect(fakes.admin.deleted).toEqual([{ id: EPHEMERAL_ID, activeWork: "cancel" }]);
    expect(fakes.errors).toContain(`Deleted temporary Tenant ${EPHEMERAL_ID}.`);
  },
);

it("dev --ephemeral deletes the Tenant on Ctrl-C", { timeout: 15_000 }, async () => {
  const root = await fixture();
  const fakes = ephemeralFakes();
  const before = process.listeners("SIGINT");
  const { code } = await runDevelop(root, ["--ephemeral", "--no-studio"], {
    stack: fakes.deps,
    admin: () => fakes.client,
    // Deliver SIGINT to the listeners dev installed, as the terminal would.
    whileRunning: () => {
      for (const listener of process.listeners("SIGINT"))
        if (!before.includes(listener)) (listener as (signal: string) => void)("SIGINT");
    },
  });
  expect(typeof code).toBe("number");
  expect(fakes.admin.deleted).toEqual([{ id: EPHEMERAL_ID, activeWork: "cancel" }]);
  expect(process.listeners("SIGINT")).toEqual(before);
  await expect(readFile(join(root, "app-stopped"), "utf8")).resolves.toBe("yes");
});

it("dev --ephemeral deletes the Tenant when seeding fails", async () => {
  const root = await fixture();
  const fakes = ephemeralFakes();
  seedFailure.error = new Error("seed rejected");
  await expect(
    develop({
      projectRoot: root,
      flags: ["--ephemeral"],
      stack: fakes.deps,
      admin: () => fakes.client,
    }),
  ).rejects.toThrow("seed rejected");
  expect(fakes.admin.deleted).toEqual([{ id: EPHEMERAL_ID, activeWork: "cancel" }]);
});

it("dev --ephemeral refuses a Runtime without the Tenant fixture model and creates nothing", async () => {
  const root = await fixture();
  const fakes = ephemeralFakes({ features: ["runtime-tenants"] });
  await expect(
    develop({
      projectRoot: root,
      flags: ["--ephemeral"],
      stack: fakes.deps,
      admin: () => fakes.client,
    }),
  ).rejects.toMatchObject({
    exitCode: 1,
    message: expect.stringContaining("tenant-fixture-model"),
  });
  expect(fakes.admin.created).toEqual([]);
  expect(seeds).toEqual([]);
});
