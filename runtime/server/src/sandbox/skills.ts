/**
 * A sandbox's skills (track R2 M4, D66): each version of a skill of the session's agent, and of
 * the agents it uses as tools (they share its sandbox), gets its files in its own folder,
 * `/skills/<name>@<hash>/` (`skillFolderOf`), read-only, so the model can read them and run their
 * scripts with bash. A version's folder is written once and never replaced: sessions whose agents
 * carry different versions of one skill share an Environment, and run turns at once, without
 * changing each other's files. The SandboxManager mounts the folders a session needs before the
 * first call that needs them; the bytes come from the Tenant's definition files. Folders live
 * outside the persisted disk, so a stop clears them and the next open mounts what is in use.
 */
import { posix } from "node:path";
import { skillFolderOf, type AgentManifest } from "@nylorun/core/define";
import { HELPER_COMMAND_TIMEOUT_MS, quote } from "./tools.js";
import type { SandboxFileBytes, SandboxHandle } from "./types.js";

/** A skill's files, by path in its folder, as `sha256:<hex>`. */
export type SkillFiles = Readonly<Record<string, string>>;

/**
 * The skill versions of the agent and the agents it uses as tools, by folder
 * (`/skills/<name>@<hash>`): each distinct version once.
 */
export function sandboxSkillsOf(
  manifest: AgentManifest | undefined,
  into = new Map<string, SkillFiles>()
): Map<string, SkillFiles> {
  for (const skill of Object.values(manifest?.skills ?? {})) {
    const folder = skillFolderOf(skill);
    if (!into.has(folder)) into.set(folder, skill.files);
  }
  for (const tool of manifest?.tools ?? [])
    if (tool.agent !== undefined && !("kind" in tool.agent)) sandboxSkillsOf(tool.agent, into);
  return into;
}

/**
 * Writes one skill version's files to its folder `root` (`/skills/<name>@<hash>`), replacing a
 * partial copy a failed mount left, and makes them read-only. `read` gives a file's bytes by
 * `sha256:<hex>`, whole or as chunks, which are written as they come.
 */
export async function mountSkill(
  handle: SandboxHandle,
  root: string,
  files: SkillFiles,
  read: (sha256: string) => Promise<SandboxFileBytes>,
  signal: AbortSignal
): Promise<void> {
  const exec = async (command: string) => {
    const result = await handle.exec({ command, cwd: "/", timeoutMs: HELPER_COMMAND_TIMEOUT_MS }, signal);
    if (result.exitCode !== 0)
      throw new Error(`${command.slice(0, 120)} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  };
  const directories = new Set<string>([root]);
  for (const path of Object.keys(files)) directories.add(posix.dirname(posix.join(root, path)));
  await exec(
    `if [ -e ${quote(root)} ]; then chmod -R u+w ${quote(root)} && rm -rf ${quote(root)}; fi && mkdir -p ${[...directories].map(quote).join(" ")}`
  );
  for (const [path, sha256] of Object.entries(files))
    await handle.writeFile(posix.join(root, path), await read(sha256));
  await exec(`chmod -R a-w ${quote(root)}`);
}
