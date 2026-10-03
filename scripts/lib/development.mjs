/**
 * `npm run dev`: the contributor loop on a local Tenant (Docker Compose).
 *
 * 1. Build the host-side packages the examples application runs on (core,
 *    harness, agents, admin, runtime, nylorun, cli).
 * 2. Build the Runtime and Studio images from this checkout
 *    (`nylorun-runtime:dev`, `nylorun-studio:dev`; NYLORUN_RUNTIME_IMAGE /
 *    NYLORUN_STUDIO_IMAGE name others) and `nylorun start` examples/' Tenant
 *    on them, in examples/: it creates the Tenant (named after examples/
 *    unless NYLORUN_TENANT names one) and links examples/ to it.
 * 3. Print a Studio login on the Tenant (`nylorun studio`), and run the
 *    examples Action endpoint with its own `npm run dev` (`tsx watch`), as a
 *    developer's project runs.
 * 4. Watch the packages: an edit rebuilds what depends on it, rebuilds the
 *    affected images (Compose then recreates only those containers), and
 *    restarts the examples runner. A failed build keeps everything running.
 */
import { existsSync } from "node:fs";
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

/** Workspace packages built on the host, in dependency order, with their dependencies. */
export const HOST_PACKAGES = {
  core: [],
  harness: ["core"],
  agents: ["core"],
  admin: ["core"],
  runtime: ["core", "harness"],
  nylorun: ["core"],
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
  nylorun: ["src"],
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
 * The real commands: npm builds, `docker build` and the workspace nylorun
 * (local Tenants). `develop` takes these as a parameter so tests can replace them.
 */
export function workspaceCommands({ repo = root, project = join(repo, "examples"), env = process.env } = {}) {
  const nylorun = join(repo, "nylorun/dist/cli.js");
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
    /** `nylorun start` in examples/: the Tenant, and the Project link once. */
    async startStack(group, { studio }) {
      const child = group.start(
        "tenant",
        process.execPath,
        [nylorun, "start", ...(studio ? [] : ["--no-studio"])],
        { cwd: project, env: stackEnv() },
      );
      if ((await child.exit) !== 0) throw new Error("nylorun start failed; see the output above.");
    },
    /** A Studio login on the examples' Tenant (`nylorun studio` reads the link). */
    async openStudio(group, { open }) {
      const child = group.start(
        "studio",
        process.execPath,
        [nylorun, "studio", ...(open ? [] : ["--no-open"])],
        { cwd: project, env: stackEnv() },
      );
      await child.exit;
    },
    startRunner(group) {
      return group.start("examples", process.execPath, [npmCli(), "run", "dev"], {
        cwd: project,
        env: stackEnv(),
      });
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
        log(`[dev] The examples runner exited (${code}); stopping. The Tenant keeps running.`);
        void close(code || 1);
      }
    },
  });

  function startRunner() {
    if (stopping) return;
    runner = commands.startRunner(group);
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
      startRunner();
    } catch (error) {
      if (!stopping)
        log(`[dev] ${error.message} The running Tenant and examples runner were retained.`);
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
    if (stopping) throw new Error("Development stopped.");
    if (options.studio && !stopping) await commands.openStudio(group, { open: options.open });
    startRunner();
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
      "[dev] Watching core, harness, agents, admin, runtime, nylorun, cli" +
        (options.studio ? " and studio" : "") +
        ". Ctrl-C stops the examples runner; `npx nylorun stop` (in examples/) stops the Tenant.",
    );
    return { close, done };
  } catch (error) {
    await close(1);
    throw error;
  }
}
