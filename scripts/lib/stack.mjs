/**
 * The local Docker stack for repository smokes, acceptance and `npm run dev`.
 *
 * - `ensureImages` builds the Runtime and Studio images from this checkout, or
 *   reuses the ones `NYLORUN_RUNTIME_IMAGE` / `NYLORUN_STUDIO_IMAGE` name (CI
 *   builds those with buildx before the smoke runs).
 * - `withStack` starts `nylorun start` under a temporary `NYLORUN_HOME` with a
 *   unique `NYLORUN_STACK_PROJECT`, hands the stack to a callback, and always
 *   ends with `nylorun reset --yes` (containers and volumes) and removes the
 *   temporary Host root.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, run } from "./repo.mjs";

/** Tags `ensureImages` builds when no image is named in the environment. */
export const LOCAL_IMAGES = Object.freeze({
  runtime: "nylorun-runtime:local",
  studio: "nylorun-studio:local",
});

const IMAGE_ENV = { runtime: "NYLORUN_RUNTIME_IMAGE", studio: "NYLORUN_STUDIO_IMAGE" };
const DOCKERFILES = { runtime: "runtime/Dockerfile", studio: "studio/Dockerfile" };

/** The workspace CLI (`npm run build` first). */
/** The workspace `nylorun` (the stack); `@nylorun/cli` is the Runtime client, `nylo`. */
export const WORKSPACE_CLI = join(root, "nylorun", "dist", "cli.js");
export const WORKSPACE_NYLO = join(root, "cli", "dist", "cli.js");

/** The image id for `tag`, or undefined when Docker has no such image. */
export async function imageId(tag) {
  try {
    return await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
      capture: true,
      timeout: 30_000,
    });
  } catch {
    return undefined;
  }
}

/**
 * The Runtime and Studio images for a stack. An image named in the
 * environment is reused as is and must exist; otherwise the default tag is
 * built from this checkout with `docker build` (quick when nothing changed,
 * since the layers are cached).
 */
export async function ensureImages({
  env = process.env,
  defaults = LOCAL_IMAGES,
  only = ["runtime", "studio"],
  log = console.log,
} = {}) {
  const images = {};
  for (const name of only) {
    const named = env[IMAGE_ENV[name]]?.trim();
    if (named) {
      if (!(await imageId(named)))
        throw new Error(
          `${IMAGE_ENV[name]}=${named} is not a local image. Build it (docker build -f ${DOCKERFILES[name]} -t ${named} .) or unset ${IMAGE_ENV[name]}.`,
        );
      log(`[stack] Using ${named} (${IMAGE_ENV[name]})`);
      images[name] = named;
      continue;
    }
    images[name] = await buildImage(name, defaults[name], { log });
  }
  return images;
}

/** `docker build` one image from the repository root; returns the tag. */
export async function buildImage(name, tag, { log = console.log } = {}) {
  log(`[stack] Building ${tag} from ${DOCKERFILES[name]}`);
  const started = Date.now();
  await run("docker", ["build", "--quiet", "--file", DOCKERFILES[name], "--tag", tag, "."], {
    cwd: root,
    capture: true,
    timeout: 1_200_000,
  });
  log(`[stack] Built ${tag} in ${Math.round((Date.now() - started) / 1000)}s`);
  return tag;
}

/** Run a command with stdout captured (and echoed) and stderr inherited. */
function exec(command, args, { env, cwd = root, echo = true, timeout = 600_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), stdout });
    });
  });
}

/** A stack project name Compose accepts: `<prefix>-<random>`. */
export function stackProjectName(prefix) {
  const base = prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `${base || "nylorun"}-${randomBytes(3).toString("hex")}`;
}

/**
 * One stack under a temporary Host root. `cli` is the `nylorun` entry to
 * drive it with and `nylo` the Runtime client's (the workspace builds by
 * default, or packed installs).
 * `baseEnv` replaces `process.env` as the environment the stack's commands
 * start from (the release smoke passes one without publishing credentials).
 */
export async function createStack({
  name = "nylorun-stack",
  cli = WORKSPACE_CLI,
  nylo = WORKSPACE_NYLO,
  images,
  baseEnv = process.env,
  env: extraEnv = {},
  log = console.log,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), `${name}-`));
  const project = stackProjectName(name);
  const env = {
    ...baseEnv,
    ...extraEnv,
    NYLORUN_HOME: home,
    NYLORUN_STACK_PROJECT: project,
    ...(images?.runtime ? { NYLORUN_RUNTIME_IMAGE: images.runtime } : {}),
    ...(images?.studio ? { NYLORUN_STUDIO_IMAGE: images.studio } : {}),
  };
  const composeArgs = (...args) => [
    "compose",
    "--project-name",
    project,
    "--file",
    join(home, "stack", "compose.yaml"),
    "--env-file",
    join(home, "stack", ".env"),
    ...args,
  ];

  const stack = {
    home,
    project,
    env,
    cli,
    runtimeUrl: undefined,
    /** Run `nylorun <args>` against this stack (`entry`: another CLI install). */
    async nylorun(args, { check = true, echo = true, cwd = root, timeout, entry = cli } = {}) {
      log(`$ nylorun ${args.join(" ")}`);
      const result = await exec(process.execPath, [entry, ...args], { env, cwd, echo, timeout });
      if (check && result.code !== 0)
        throw new Error(`nylorun ${args.join(" ")} exited with ${result.code}`);
      return result;
    },
    /** Run `nylo <args>` (the Runtime client) against this stack's Host root. */
    async nylo(args, { check = true, echo = true, cwd = root, timeout, entry = nylo } = {}) {
      log(`$ nylo ${args.join(" ")}`);
      const result = await exec(process.execPath, [entry, ...args], { env, cwd, echo, timeout });
      if (check && result.code !== 0)
        throw new Error(`nylo ${args.join(" ")} exited with ${result.code}:\n${result.stderr ?? ""}`);
      return result;
    },
    /** `nylorun start`; returns the Runtime URL and Studio login URL it prints. */
    async start(args = []) {
      const { stdout } = await stack.nylorun(["start", ...args]);
      const runtimeUrl = /^Runtime\s+(\S+)/m.exec(stdout)?.[1];
      assert.ok(runtimeUrl, `nylorun start prints the Runtime URL:\n${stdout}`);
      stack.runtimeUrl = runtimeUrl;
      return { runtimeUrl, studioUrl: /^Studio\s+(\S+)/m.exec(stdout)?.[1] };
    },
    /** `docker compose` on this stack's project; returns stdout. */
    async compose(args, { check = true, echo = false } = {}) {
      const result = await exec("docker", composeArgs(...args), { env, echo });
      if (check && result.code !== 0)
        throw new Error(`docker compose ${args.join(" ")} exited with ${result.code}`);
      return result.stdout;
    },
    /** One SQL statement through `psql` in the postgres container; rows as text. */
    async psql(sql) {
      return (
        await stack.compose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "--username",
          "nylorun",
          "--dbname",
          "nylorun",
          "--no-align",
          "--tuples-only",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          sql,
        ])
      ).trim();
    },
    /** A fresh single-use Studio login URL (`nylorun studio --no-open`). */
    async studioLogin(args = []) {
      const { stdout } = await stack.nylorun(["studio", "--no-open", ...args], { echo: false });
      const url = /^Studio\s+(\S+)/m.exec(stdout)?.[1];
      assert.match(url ?? "", /^http:\/\/localhost:\d+\/login\?token=/, stdout);
      return url;
    },
    /** `@nylorun/admin` for this Host root (`module`: a packed install's entry). */
    async admin(module = "@nylorun/admin") {
      const { createAdmin } = await import(module);
      return createAdmin({ home });
    },
    async logs(tail = 200) {
      if (!existsSync(join(home, "stack", "compose.yaml"))) return;
      await stack.nylorun(["logs", "--tail", String(tail)], { check: false });
    },
    /** Delete containers and volumes, then the temporary Host root. */
    async dispose() {
      const reset = await stack
        .nylorun(["reset", "--yes"], { check: false, echo: false })
        .catch(() => ({ code: 1 }));
      // Without compose files (start failed early) Compose finds the
      // containers by project label.
      if (reset.code !== 0)
        await exec("docker", ["compose", "--project-name", project, "down", "--volumes", "--remove-orphans"], {
          env,
          echo: false,
        }).catch(() => {});
      await rm(home, { recursive: true, force: true });
    },
  };
  return stack;
}

/**
 * Run `fn(stack)` on a fresh stack and always reset it afterwards. With
 * `start: false` the callback starts it (e.g. through `nylorun up`). Logs
 * are printed when the callback fails; Ctrl-C still resets.
 */
export async function withStack(options, fn) {
  const stack = await createStack(options);
  const interrupt = (signal) => {
    console.error(`[stack] ${signal}: resetting ${stack.project}`);
    void stack.dispose().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    if (options?.start !== false) await stack.start(options?.startArgs ?? []);
    return await fn(stack);
  } catch (error) {
    await stack.logs().catch(() => {});
    throw error;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await stack.dispose();
  }
}

/**
 * Redeem a Studio login URL like a browser: `303` with a session cookie.
 * Returns `get(path)` for authenticated Studio requests.
 */
export async function studioSession(loginUrl) {
  const redeemed = await fetch(loginUrl, { redirect: "manual" });
  assert.equal(redeemed.status, 303, `Studio login redirects (${redeemed.status})`);
  const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Studio login sets a session cookie");
  const origin = new URL(loginUrl).origin;
  return {
    origin,
    location: redeemed.headers.get("location"),
    cookie,
    get: (path, init = {}) =>
      fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, cookie } }),
  };
}

/** Poll `check` until it returns a truthy value; fail with `describe()` on timeout. */
export async function eventually(check, { timeout = 60_000, interval = 250, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${message}${last ? ` (${last})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const PROTOCOL = "3";

/** Headers for the Tenant API. */
export function tenantHeaders(tenantId, key, extra = {}) {
  return {
    authorization: `Bearer ${key}`,
    "Nylorun-Tenant": tenantId,
    "Nylorun-Protocol": PROTOCOL,
    ...extra,
  };
}

/** GET a Tenant API path as JSON (throws on a non-2xx status). */
export async function tenantGet(runtimeUrl, tenantId, key, path) {
  const response = await fetch(`${runtimeUrl}${path}`, {
    headers: tenantHeaders(tenantId, key),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
