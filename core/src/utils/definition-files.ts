/**
 * Definition files (track R2 M4): the files a definition names by content hash, uploaded once
 * with `PUT /v1/files/sha256:<hex>` and held by the Runtime. Today they are the files of a
 * skill's folder (`SkillManifest.files`). Shared by the SDK, the wire schema and the Runtime.
 */

/** The largest definition file the Runtime stores. */
export const DEFINITION_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** The most files one skill may have. */
export const SKILL_FILES_MAX = 500;
/** The longest path of a file in a skill's folder. */
export const SKILL_FILE_PATH_MAX = 512;
/** The file every skill has: its frontmatter and instructions. */
export const SKILL_ENTRY = "SKILL.md";
/** Where a session's sandbox holds each skill's files, read-only: `/skills/<name>/`. */
export const SKILLS_MOUNT = "/skills";

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

/** Why `files` is not a skill's file map, or undefined when it is. */
export function skillFilesIssue(files: unknown): string | undefined {
  if (!files || typeof files !== "object" || Array.isArray(files))
    return `files must map each path in the skill's folder to sha256:<hex>`;
  const entries = Object.entries(files);
  if (entries.length > SKILL_FILES_MAX)
    return `has ${entries.length} files; a skill may have at most ${SKILL_FILES_MAX}`;
  if (!(SKILL_ENTRY in files)) return `files must include ${SKILL_ENTRY}`;
  for (const [path, hash] of entries) {
    const issue = skillFilePathIssue(path);
    if (issue) return `file path ${JSON.stringify(path.slice(0, 80))} ${issue}`;
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
  if (!document || typeof document !== "object") return into;
  const value = document as {
    kind?: string;
    agents?: Record<string, unknown>;
    capabilities?: {
      skills?: Record<string, { files?: Record<string, unknown> }>;
      tools?: { agent?: unknown }[];
    }[];
  };
  if (value.kind === "workflow") {
    for (const agent of Object.values(value.agents ?? {})) definitionFilesOf(agent, into);
    return into;
  }
  for (const capability of value.capabilities ?? []) {
    for (const skill of Object.values(capability.skills ?? {}))
      for (const hash of Object.values(skill?.files ?? {}))
        if (isDefinitionFileHash(hash)) into.add(hash);
    for (const tool of capability.tools ?? []) definitionFilesOf(tool.agent, into);
  }
  return into;
}

/**
 * A `SKILL.md`'s instructions: the text after its YAML frontmatter (`---` lines), without the
 * blank line that follows it. Text without frontmatter is returned whole.
 */
export function skillInstructions(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^\r?\n/, "") : text;
}
