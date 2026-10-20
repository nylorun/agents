/**
 * `nylorun apply --watch [--save]` (track T7, design §6): checks the folders and plans their
 * manifests at once, then again on each change to them (debounced), until interrupted. It saves
 * only with `--save`: each save is a new immutable version that moves the Agents tracking the
 * name, so `--watch --save` is for a development manifest. A cycle that fails (a Runtime that
 * refuses, a folder that does not pack) prints why and the watch goes on. The file a
 * `runtime.json` `extends` is watched too.
 */
import { watch as watchFiles } from "node:fs";
import { relative, resolve } from "node:path";
import type { StackDeps } from "../stack/commands.js";
import { applyCommand } from "./apply.js";
import { agentFolders, checkCommand, packed } from "./folder.js";

/** Watches `paths` (folders recursively, or files), calling `onChange` with a path that changed. */
export type FolderWatcher = (paths: readonly string[], onChange: (path: string) => void) => { close(): void };

/** `node:fs` `watch`, recursive for a folder. */
export const nodeWatcher: FolderWatcher = (paths, onChange) => {
  const watchers = paths.map((path) =>
    watchFiles(path, { recursive: true }, (_event, file) => onChange(file ? resolve(path, String(file)) : path)),
  );
  return { close: () => watchers.forEach((watcher) => watcher.close()) };
};

/** What changes that never start a cycle: version control and dependencies. */
const QUIET = /(^|[\\/])(\.git|node_modules|\.hg|\.svn)([\\/]|$)/;

export interface WatchOptions {
  watcher?: FolderWatcher;
  /** Ends the watch; by default SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** How long changes settle before a cycle (default 200 ms). */
  debounceMs?: number;
}

/**
 * Checks and plans `dirs` (apply's other flags in `args`) now and on each change, saving with
 * `save`, until the signal ends it.
 */
export async function watchApply(
  deps: StackDeps,
  run: { dirs: readonly string[]; args: readonly string[]; save: boolean },
  options: WatchOptions = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const dirs = run.dirs.length > 0 ? run.dirs : ["."];
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const stop = () => controller.abort();
  if (!options.signal) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  const cycle = async () => {
    try {
      if ((await checkCommand(deps, dirs)) === 0) await applyCommand(deps, run.args, { planOnly: !run.save, checked: true });
    } catch (error) {
      deps.err(error instanceof Error ? error.message : String(error));
    }
    deps.out(`Watching ${dirs.join(", ")} for changes${run.save ? ", saving each" : ""} (Ctrl-C stops).`);
  };

  // The folders, and the files their runtime.json extends.
  const paths = new Set(dirs.map((dir) => resolve(cwd, dir)));
  for (const dir of dirs)
    for (const folder of await agentFolders(resolve(cwd, dir)).catch(() => []))
      for (const file of (await packed(folder).catch(() => undefined))?.extended ?? []) paths.add(file);

  let running: Promise<void> = cycle();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed: string | undefined;
  const watcher = (options.watcher ?? nodeWatcher)([...paths], (path) => {
    if (QUIET.test(path)) return;
    changed = path;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const what = changed;
      running = running.then(async () => {
        if (signal.aborted) return;
        deps.out("");
        deps.out(`${what === undefined ? "A file" : relative(cwd, what) || "."} changed: checking again.`);
        await cycle();
      });
    }, options.debounceMs ?? 200);
  });
  try {
    await new Promise<void>((done) => {
      if (signal.aborted) done();
      else signal.addEventListener("abort", () => done(), { once: true });
    });
  } finally {
    clearTimeout(timer);
    watcher.close();
    if (!options.signal) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  await running;
  return 0;
}
