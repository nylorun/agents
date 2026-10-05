/**
 * A sandbox's skills (track R2 M4): each skill of the session's agent, and of the agents it uses
 * as tools (they share its sandbox), gets its files under `/skills/<name>/`, read-only, so the
 * model can read them and run their scripts with bash. The SandboxManager mounts them on a
 * workspace before the first call of a session's run that opens it, and again when a session
 * with other skills uses it; the bytes come from the Tenant's definition files.
 */
import { posix } from "node:path";
import { SKILLS_MOUNT, type AgentManifest } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import { quote } from "./tools.js";
import type { SandboxHandle } from "./types.js";

/** A skill's files, by path in its folder, as `sha256:<hex>`. */
export type SkillFiles = Readonly<Record<string, string>>;

/** The skills of the agent and the agents it uses as tools; the first of a name wins. */
export function sandboxSkillsOf(
  manifest: AgentManifest | undefined,
  into = new Map<string, SkillFiles>()
): Map<string, SkillFiles> {
  for (const capability of manifest?.capabilities ?? []) {
    for (const skill of Object.values(capability.skills ?? {}))
      if (!into.has(skill.name)) into.set(skill.name, skill.files);
    for (const tool of capability.tools ?? [])
      if (tool.agent !== undefined && !("kind" in tool.agent)) sandboxSkillsOf(tool.agent, into);
  }
  return into;
}

/** What a mounted skill holds, to tell whether a workspace has these files already. */
export function skillSignature(files: SkillFiles): string {
  return canonical(files);
}

/**
 * Writes one skill's files to `/skills/<name>/` of the sandbox, replacing what was there, and
 * makes them read-only. `read` gives a file's bytes by `sha256:<hex>`.
 */
export async function mountSkill(
  handle: SandboxHandle,
  name: string,
  files: SkillFiles,
  read: (sha256: string) => Promise<Uint8Array>,
  signal: AbortSignal
): Promise<void> {
  const root = `${SKILLS_MOUNT}/${name}`;
  const exec = async (command: string) => {
    const result = await handle.exec({ command, cwd: "/", timeoutMs: 60_000 }, signal);
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
