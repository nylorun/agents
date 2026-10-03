import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where `nylo` keeps its own files (the installation id): an explicit home,
 * `NYLORUN_HOME`, or `~/.nylorun`, which holds the local Tenants' Host roots
 * (`tenants/<name>/`). `@nylorun/admin` resolves a Tenant's Host root itself.
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
