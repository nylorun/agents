import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/**
 * The nearest `.nylorun` wins so an initialised Project keeps working from a
 * subdirectory; otherwise the nearest package.json defines the Project. The
 * walk stops at the home directory because `~/.nylorun` is the Host root, never
 * a Project root.
 */
export function findProjectRoot(cwd = process.cwd()): string | undefined {
  const stop = (() => {
    try {
      return realpathSync(homedir());
    } catch {
      return homedir();
    }
  })();
  let directory = resolve(cwd);
  try {
    directory = realpathSync(directory);
  } catch {
    /* unresolvable cwd falls through */
  }
  const root = parse(directory).root;
  let fallback: string | undefined;
  for (;;) {
    // The home directory is never a Project, but a package.json below it is.
    if (directory === stop) return fallback;
    if (existsSync(join(directory, ".nylorun"))) return directory;
    if (!fallback && existsSync(join(directory, "package.json")))
      fallback = directory;
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return fallback;
}
