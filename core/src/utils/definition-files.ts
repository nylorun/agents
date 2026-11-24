/**
 * Definition files: the files a definition names by content hash, uploaded once
 * with `PUT /v1/files/sha256:<hex>` and held by the Runtime: the files of a skill's folder
 * (`SkillManifest.files`), and those of an Agent Plugin mounted whole (`PluginManifest.files`).
 * Shared by the SDK, the wire schema and the Runtime.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonical } from "./canonical.js";
import { FILE_NAME_MAX, FILE_PATH_MAX } from "./file-systems.js";

/**
 * The most bytes one skill's files may hold together when the Tenant sets no limit of its own
 * (2 GiB, Tenant setting `skills.config`); an agent manifest's `runtime.limits.skills.totalBytes`
 * may set a lower one. No file
 * and no count of files has a limit of its own.
 */
export const SKILL_TOTAL_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;
/** The file every skill has: its frontmatter and instructions. */
export const SKILL_ENTRY = "SKILL.md";
/** Where a session's sandbox holds each skill's files, read-only: `/skills/<name>@<hash>/`. */
export const SKILLS_MOUNT = "/skills";
/**
 * The longest path of a file in a skill's folder: what the longest path a workspace's file
 * system takes (`FILE_PATH_MAX`) leaves under the skill's mount folder, `/skills/<name>@<12 hex>/`
 * with a name as long as a file name may be.
 */
export const SKILL_FILE_PATH_MAX =
  FILE_PATH_MAX - `${SKILLS_MOUNT}/${"n".repeat(FILE_NAME_MAX)}@${"0".repeat(12)}/`.length;

/**
 * The folder of a sandbox that holds one version of a skill, read-only:
 * `/skills/<name>@<12 hex>`, the hex from the SHA-256 of its canonical file map. A version keeps
 * its folder and is never replaced, so sessions whose agents carry different versions of a skill
 * share an Environment without changing each other's files.
 */
export function skillFolderOf(skill: { readonly name: string; readonly files: Readonly<Record<string, string>> }): string {
  return `${SKILLS_MOUNT}/${skill.name}@${bytesToHex(sha256(utf8ToBytes(canonical(skill.files)))).slice(0, 12)}`;
}

/** Where a session's sandbox holds each mounted Agent Plugin's files, read-only: `/plugins/<name>@<hash>/`. */
export const PLUGINS_MOUNT = "/plugins";
/** The longest path of a file in a mounted plugin's folder, as `SKILL_FILE_PATH_MAX` is a skill's. */
export const PLUGIN_FILE_PATH_MAX =
  FILE_PATH_MAX - `${PLUGINS_MOUNT}/${"n".repeat(FILE_NAME_MAX)}@${"0".repeat(12)}/`.length;

/**
 * The folder of a sandbox that holds one version of an Agent Plugin's files, read-only:
 * `/plugins/<name>@<12 hex>`, the hex from the SHA-256 of its canonical file map, as `skillFolderOf`.
 */
export function pluginFolderOf(plugin: { readonly name: string; readonly files: Readonly<Record<string, string>> }): string {
  return `${PLUGINS_MOUNT}/${plugin.name}@${bytesToHex(sha256(utf8ToBytes(canonical(plugin.files)))).slice(0, 12)}`;
}

const FILE_HASH = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>`, the way a manifest names a definition file. */
export function isDefinitionFileHash(value: unknown): value is string {
  return typeof value === "string" && FILE_HASH.test(value);
}

/** Why `path` cannot name a file in a skill's folder, or undefined when it can. */
export function skillFilePathIssue(path: string): string | undefined {
  if (path.length === 0 || path.length > SKILL_FILE_PATH_MAX)
    return `must be 1 to ${SKILL_FILE_PATH_MAX} characters`;
  if (path.includes("\\")) return "must use / as its separator, not \\";
  if (path.startsWith("/")) return "must be relative to the skill's folder";
  if (/[\u0000-\u001f]/.test(path)) return "must not contain control characters";
  for (const segment of path.split("/"))
    if (segment === "" || segment === "." || segment === "..")
      return "must not have empty, . or .. segments";
  return undefined;
}

/** Why `files` is not a mounted plugin's file map, or undefined when it is. */
export function pluginFilesIssue(files: unknown): string | undefined {
  if (!files || typeof files !== "object" || Array.isArray(files))
    return `files must map each path in the plugin's folder to sha256:<hex>`;
  for (const [path, hash] of Object.entries(files)) {
    const issue = path.length > PLUGIN_FILE_PATH_MAX ? `must be 1 to ${PLUGIN_FILE_PATH_MAX} characters` : skillFilePathIssue(path)?.replace("the skill's folder", "the plugin's folder");
    if (issue) return `file path ${JSON.stringify(path.slice(0, FILE_PATH_MAX))} ${issue}`;
    if (!isDefinitionFileHash(hash))
      return `file ${JSON.stringify(path)} must name its content as sha256:<64 lowercase hex>`;
  }
  return undefined;
}

/** Why `files` is not a skill's file map, or undefined when it is. */
export function skillFilesIssue(files: unknown): string | undefined {
  if (!files || typeof files !== "object" || Array.isArray(files))
    return `files must map each path in the skill's folder to sha256:<hex>`;
  const entries = Object.entries(files);
  if (!(SKILL_ENTRY in files)) return `files must include ${SKILL_ENTRY}`;
  for (const [path, hash] of entries) {
    const issue = skillFilePathIssue(path);
    if (issue) return `file path ${JSON.stringify(path.slice(0, FILE_PATH_MAX))} ${issue}`;
    if (!isDefinitionFileHash(hash))
      return `file ${JSON.stringify(path)} must name its content as sha256:<64 lowercase hex>`;
  }
  return undefined;
}

/**
 * Every definition file a definition document names: its agents' skill files, those of the
 * agents it uses as tools, and those of a flow's agents, as `sha256:<hex>`.
 */
export function definitionFilesOf(document: unknown, into = new Set<string>()): Set<string> {
  for (const owner of [...skillsOf(document), ...mountedPluginsOf(document)])
    for (const hash of Object.values(owner.files ?? {}))
      if (isDefinitionFileHash(hash)) into.add(hash);
  return into;
}

/**
 * Every Agent Plugin a definition document mounts whole (a loop manifest's `plugins` with
 * `files`): its agents', those of the agents it uses as tools, and those of a flow's agents. A
 * plugin two agents carry comes once for each.
 */
export function* mountedPluginsOf(
  document: unknown,
): Generator<{ readonly name?: unknown; readonly files?: Readonly<Record<string, unknown>> }> {
  if (!document || typeof document !== "object") return;
  const value = document as {
    kind?: string;
    agents?: Record<string, unknown>;
    plugins?: { name?: unknown; files?: Record<string, unknown> }[];
    tools?: { agent?: unknown }[];
  };
  if (value.kind === "workflow") {
    for (const agent of Object.values(value.agents ?? {})) yield* mountedPluginsOf(agent);
    return;
  }
  if (Array.isArray(value.plugins)) for (const plugin of value.plugins) if (plugin?.files) yield plugin;
  for (const tool of value.tools ?? []) yield* mountedPluginsOf(tool.agent);
}

/**
 * Every skill a definition document carries, as written: its agents' skills, those of the agents
 * it uses as tools, and those of a flow's agents. A skill two agents carry comes once for each.
 */
export function* skillsOf(
  document: unknown,
): Generator<{ readonly name?: unknown; readonly files?: Readonly<Record<string, unknown>> }> {
  if (!document || typeof document !== "object") return;
  const value = document as {
    kind?: string;
    agents?: Record<string, unknown>;
    skills?: Record<string, { name?: unknown; files?: Record<string, unknown> } | undefined>;
    tools?: { agent?: unknown }[];
  };
  if (value.kind === "workflow") {
    for (const agent of Object.values(value.agents ?? {})) yield* skillsOf(agent);
    return;
  }
  for (const skill of Object.values(value.skills ?? {})) if (skill) yield skill;
  for (const tool of value.tools ?? []) yield* skillsOf(tool.agent);
}

/**
 * A `SKILL.md`'s instructions: the text after its YAML frontmatter (`---` lines), without the
 * blank line that follows it. Text without frontmatter is returned whole.
 */
export function skillInstructions(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^\r?\n/, "") : text;
}
