/**
 * Agent memory (track T5, D72): what a memory's path may be, and what its index line shows.
 * The Runtime and the engine's `memory` tool share these rules, so a path the tool accepts is one
 * the Runtime stores.
 *
 * A memory is a Markdown file under `/memories`: its path is `/memories/` and one or more
 * `/`-separated segments, ends in `.md`, has no `.` or `..` segment, no empty segment, no
 * backslash or control character, and is at most `MEMORY_PATH_MAX` characters. Folders are only
 * the prefixes of memory paths; no row holds one.
 */

/** Where an Agent's memories live, in the tool and in every path the Runtime stores. */
export const MEMORY_ROOT = "/memories";
/** The longest memory path, `/memories/` included. */
export const MEMORY_PATH_MAX = 512;
/** The longest `harness.memory.instructions`. */
export const MEMORY_INSTRUCTIONS_MAX = 4096;
/** The longest description an index line shows. */
export const MEMORY_DESCRIPTION_MAX = 200;
/** What `harness.memory.access` may be: reads and writes, or reads only. */
export const MEMORY_ACCESS = ["read_write", "read_only"] as const;
export type MemoryAccess = (typeof MEMORY_ACCESS)[number];
/** What changed a memory, as a version records it. */
export const MEMORY_OPERATIONS = ["create", "str_replace", "insert", "delete", "rename"] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

// Control characters (C0, DEL, C1) and the backslash; a path holds neither.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\\]/;

/**
 * Normalises a path the model or an API caller sent: a trailing `/` is dropped, and a path
 * without the leading `/` of `/memories` gets it. Answers the path, or why it is refused.
 * `kind: "file"` requires a memory's path (ending in `.md`); `kind: "any"` also takes a folder,
 * `/memories` itself included.
 */
export function memoryPathOf(
  raw: string,
  kind: "file" | "any",
): { path: string } | { error: string } {
  let path = raw.trim();
  if (path.startsWith("memories/") || path === "memories") path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path !== MEMORY_ROOT && !path.startsWith(`${MEMORY_ROOT}/`))
    return { error: `${raw} is not under ${MEMORY_ROOT}: memory paths start with ${MEMORY_ROOT}/` };
  if (path.length > MEMORY_PATH_MAX) return { error: `A memory path is at most ${MEMORY_PATH_MAX} characters` };
  if (FORBIDDEN.test(path)) return { error: "A memory path has no backslash or control character" };
  const segments = path.slice(MEMORY_ROOT.length + 1).split("/");
  if (path !== MEMORY_ROOT && segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return { error: `${raw} has an empty, "." or ".." segment` };
  if (kind === "file") {
    if (path === MEMORY_ROOT) return { error: `${MEMORY_ROOT} is the memory folder, not a memory` };
    if (!path.endsWith(".md") || path.endsWith("/.md"))
      return { error: `${path} must end in .md: memories are Markdown files` };
  }
  return { path };
}

/** Whether `path` is `folder` or inside it (`folder` a normalised memory path). */
export function memoryPathWithin(path: string, folder: string): boolean {
  return folder === MEMORY_ROOT ? path.startsWith(`${MEMORY_ROOT}/`) : path === folder || path.startsWith(`${folder}/`);
}

/**
 * What a memory's index line shows: the `description` of its YAML frontmatter, when it has one,
 * cut to `MEMORY_DESCRIPTION_MAX` characters; otherwise `null`. Frontmatter is optional and the
 * Runtime never writes into a memory.
 */
export function memoryDescriptionOf(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  const line = /^description:[ \t]*(.*)$/m.exec(match[1]!);
  if (!line) return null;
  let value = line[1]!.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    value = value.slice(1, -1).trim();
  if (value === "") return null;
  return value.length > MEMORY_DESCRIPTION_MAX ? `${value.slice(0, MEMORY_DESCRIPTION_MAX - 1)}…` : value;
}
