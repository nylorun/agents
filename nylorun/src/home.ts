import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The Host root: an explicit home, `NYLORUN_HOME`, or `~/.nylorun`. Compose
 * bind-mounts it into the Runtime and Studio containers, and `@nylorun/admin`
 * reads `host.json` and the admin key from it.
 */
export function resolveHome(
  home?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = env.NYLORUN_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}
