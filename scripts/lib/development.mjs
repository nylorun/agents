/**
 * `npm run dev`: the contributor loop on the local Docker stack.
 *
 * 1. Build the host-side packages the examples application runs on (core,
 *    harness, agents, admin, runtime, cli).
 * 2. Build the Runtime and Studio images from this checkout
 *    (`nylorun-runtime:dev`, `nylorun-studio:dev`; NYLORUN_RUNTIME_IMAGE /
 *    NYLORUN_STUDIO_IMAGE name others) and `nylorun start` the stack on them.
 * 3. Run `nylorun dev` in examples/: it links the Project's Tenant, prints the
 *    Studio login URL and runs the examples executor under `tsx watch`.
 * 4. Watch the packages: an edit rebuilds what depends on it, rebuilds the
 *    affected images (Compose then recreates only those containers), and
 *    restarts the examples runner. A failed build keeps everything running.
 */
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { watch } from "chokidar";
import { ProcessGroup } from "./processes.mjs";
import { npmCli, root } from "./repo.mjs";
import { buildImage, ensureImages } from "./stack.mjs";

export function developmentOptions(args) {
  const options = { studio: true, open: true, watch: true };
  const seen = new Set();
  for (const flag of args) {
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--no-studio") options.studio = false;
    else if (flag === "--no-open") options.open = false;
    else if (flag === "--no-watch") options.watch = false;
    else
      throw new Error(`Unknown option: ${flag}. Use --no-studio, --no-open, --no-watch.`);
  }
  if (!options.studio) options.open = false;
  return options;
}

/** A free loopback port (or `port` when it is free). */
export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `Port ${port} is unavailable (${error.code}). Stop the other service or choose another port.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

/** Workspace packages built on the host, in dependency order, with their dependencies. */
export const HOST_PACKAGES = {
  core: [],
  harness: ["core"],
  agents: ["core"],
  admin: ["core"],
  runtime: ["core", "harness"],
  cli: ["agents", "admin"],
};

/** The packages each image is built from (see runtime/Dockerfile, studio/Dockerfile). */
export const IMAGE_SOURCES = {
  runtime: ["core", "harness", "runtime"],
  studio: ["core", "agents", "admin", "studio"],
};

/** Directories watched per package (studio's web UI lives outside src/). */
const WATCHED = {
  core: ["src"],
  harness: ["src"],
  agents: ["src"],
  admin: ["src"],
  runtime: ["src"],
  cli: ["src"],
  studio: ["src", "web"],
};

/**
 * What to rebuild after `changed` packages were edited: the host packages
 * that are or depend on them (in build order) and the images built from them.
 */
export function rebuildPlan(changed, { studio = true } = {}) {
  const affected = new Set(changed);
  for (const [name, deps] of Object.entries(HOST_PACKAGES))
    if (deps.some((dep) => affected.has(dep))) affected.add(name);
  return {
    packages: Object.keys(HOST_PACKAGES).filter((name) => affected.has(name)),
    images: Object.entries(IMAGE_SOURCES)
      .filter(([image, sources]) => (image !== "studio" || studio) && sources.some((s) => changed.includes(s)))
      .map(([image]) => image),
  };
}

/** The package a changed path belongs to, or undefined for anything unwatched. */
export function packageOf(repo, path) {
  const [name, directory] = relative(repo, path).split(sep);
  if (!WATCHED[name]?.includes(directory)) return undefined;
  if (/[/\\](dist|node_modules)[/\\]/.test(path)) return undefined;
  return name;
}

/**
 * The real commands: npm builds, `docker build`, and the workspace CLI.
 * `develop` takes these as a parameter so tests can replace them.
 */
export function workspaceCommands({ repo = root, project = join(repo, "examples"), env = process.env } = {}) {
  const cli = join(repo, "cli/dist/cli.js");
  const images = { runtime: "nylorun-runtime:dev", studio: "nylorun-studio:dev" };
  const stackEnv = () => ({
    ...env,
    NYLORUN_RUNTIME_IMAGE: images.runtime,
    NYLORUN_STUDIO_IMAGE: images.studio,
  });
  return {
    async buildPackage(group, name) {
      const child = group.start(`${name}:build`, process.execPath, [npmCli(), "run", "build"], {
        cwd: join(repo, name),
      });
      if ((await child.exit) !== 0) throw new Error(`${name} failed to build.`);
    },
    /** Every image not named in the environment is built from this checkout. */
    async prepareImages(log) {
      Object.assign(
        images,
        await ensureImages({ env, defaults: images, log }),
      );
    },
    async buildImage(name, log) {
      // An image named in the environment is someone else's build; keep it.
      if (env[name === "runtime" ? "NYLORUN_RUNTIME_IMAGE" : "NYLORUN_STUDIO_IMAGE"]?.trim()) {
        log(`[dev] ${name} image is set in the environment; not rebuilding it.`);
        return;
      }
      await buildImage(name, images[name], { log });
    },
    async startStack(group, { studio }) {
      const child = group.start(
        "stack",
        process.execPath,
        [cli, "start", ...(studio ? [] : ["--no-studio"])],
        { cwd: project, env: stackEnv() },
      );
      if ((await child.exit) !== 0) throw new Error("nylorun start failed; see the output above.");
    },
    startRunner(group, { studio, open }) {
      // The CLI's Project lookup stops at the home directory before it falls
      // back to the nearest package.json (cli/src/project/root.ts), so a
      // checkout under $HOME needs the Project's .nylorun/ to exist.
      mkdirSync(join(project, ".nylorun"), { recursive: true, mode: 0o700 });
      return group.start(
        "examples",
        process.execPath,
        [cli, "dev", ...(studio ? [] : ["--no-studio"]), ...(open ? [] : ["--no-open"])],
        { cwd: project, env: stackEnv() },
      );
    },
  };
}

/** Run the contributor loop until `signal` aborts or the runner exits on its own. */
export async function develop(
  options,
  {
    repo = root,
    log = console.log,
    signal,
    built = false,
    commands = workspaceCommands({ repo }),
    debounceMs = 200,
    /** chokidar options (tests poll, which does not drop early events). */
    watchOptions = {},
  } = {},
) {
  let stopping = false;
  let runner;
  let watcher;
  let timer;
  let work = Promise.resolve();
  const pending = new Set();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const group = new ProcessGroup({
    log,
    onExit(label, code) {
      if (!stopping && label === "examples") {
        log(`[dev] The examples runner exited (${code}); stopping. The stack keeps running.`);
        void close(code || 1);
      }
    },
  });

  function startRunner(open) {
    if (stopping) return;
    runner = commands.startRunner(group, { studio: options.studio, open });
  }

  async function rebuild(changed) {
    const plan = rebuildPlan(changed, options);
    log(
      `[dev] ${changed.join(", ")} changed: rebuilding ${[
        ...plan.packages,
        ...plan.images.map((image) => `${image} image`),
      ].join(", ") || "nothing"}`,
    );
    try {
      for (const name of plan.packages) await commands.buildPackage(group, name);
      for (const image of plan.images) await commands.buildImage(image, log);
      if (stopping) return;
      if (plan.images.length) await commands.startStack(group, options);
      if (stopping || (!plan.packages.length && !plan.images.length)) return;
      log("[dev] Restarting the examples runner.");
      await runner?.stop();
      startRunner(false);
    } catch (error) {
      if (!stopping)
        log(`[dev] ${error.message} The running stack and examples runner were retained.`);
    }
  }

  async function close(code = 0) {
    if (stopping) return done;
    stopping = true;
    clearTimeout(timer);
    await watcher?.close();
    await group.close();
    await work.catch(() => {});
    resolveDone(code);
    return code;
  }

  signal?.addEventListener("abort", () => void close(), { once: true });
  try {
    if (signal?.aborted) throw new Error("Development stopped.");
    if (!built)
      for (const name of Object.keys(HOST_PACKAGES)) {
        if (stopping) throw new Error("Development stopped.");
        await commands.buildPackage(group, name);
      }
    if (stopping) throw new Error("Development stopped.");
    await commands.prepareImages(log);
    if (stopping) throw new Error("Development stopped.");
    await commands.startStack(group, options);
    startRunner(options.open);
    if (!options.watch) return { close, done };

    const directories = Object.entries(WATCHED)
      .filter(([name]) => name !== "studio" || options.studio)
      .flatMap(([name, dirs]) => dirs.map((dir) => join(repo, name, dir)))
      .filter((dir) => existsSync(dir));
    watcher = watch(directories, { ignoreInitial: true, ...watchOptions });
    watcher.on("all", (_event, path) => {
      if (stopping) return;
      const name = packageOf(repo, path);
      if (!name) return;
      pending.add(name);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const names = [...pending];
        pending.clear();
        work = work.then(() => rebuild(names));
      }, debounceMs);
    });
    await Promise.race([
      new Promise((resolve, reject) => {
        watcher.once("ready", resolve);
        watcher.once("error", reject);
      }),
      done.then(() => {
        throw new Error("Development stopped.");
      }),
    ]);
    watcher.on("error", (error) => {
      log(`[dev] Watcher failed: ${error.message}`);
      void close(1);
    });
    log(
      "[dev] Watching core, harness, agents, admin, runtime, cli" +
        (options.studio ? " and studio" : "") +
        ". Ctrl-C stops the examples runner; `npx nylorun stop` (in examples/) stops the stack.",
    );
    return { close, done };
  } catch (error) {
    await close(1);
    throw error;
  }
}
