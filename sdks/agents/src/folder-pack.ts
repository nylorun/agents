/**
 * Packing an agent folder (track T6): `packFolder(dir)` lists every file with its size and SHA-256
 * and reads its bytes on demand. It skips `.git`, `.hg`, `.svn` and `node_modules`, what the
 * folder's `.nyloignore` names (gitignore rules, `folder-ignore.ts`; track T7), and follows no
 * symbolic link.
 *
 * `extends` in `runtime.json` (track T7, design §3.9) names a shared JSON file, inside the folder
 * or outside it, by a path relative to the file that names it. The packed `runtime.json` is the
 * merge, the folder's own keys winning (objects merge, arrays replace), so every saved version is
 * self-contained and its source is what was sent; `.nylorun/origin.json` in the pack names the
 * files it was merged from. A chain of `extends` resolves in turn; a cycle, a missing file or
 * one that is not a JSON object is a `FolderError`. Node only: it reads the folder.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AGENT_FOLDER_LIMITS, type AgentFolderEntry } from "@nylorun/core/folder";
import type { SkillFileSource } from "@nylorun/core/define";
import { AGENT_FOLDER_FILE, FolderError, type PackedFolder } from "./folder.js";
import { ignoreMatcher } from "./folder-ignore.js";

const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

/** The file, at a folder's top, that names what packing leaves out (gitignore syntax). */
export const FOLDER_IGNORE_FILE = ".nyloignore";
const RUNTIME_FILE = "runtime.json";
const ORIGIN_FILE = ".nylorun/origin.json";

/** Whether `dir` holds an `AGENT.md`. */
export async function isAgentFolder(dir: string): Promise<boolean> {
  return stat(join(dir, AGENT_FOLDER_FILE)).then(
    (found) => found.isFile(),
    () => false,
  );
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** `over` merged onto `under`: `over`'s keys win, objects merge, arrays and the rest replace. */
function merge(under: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key];
    merged[key] = isObject(below) && isObject(value) ? merge(below, value) : value;
  }
  return merged;
}

/**
 * `runtime.json` with its `extends` resolved, and each file it was merged from (absolute paths,
 * nearest first); undefined when it says no `extends`, or is not a JSON object (the compiler
 * reports that with its position).
 */
async function resolveExtends(root: string, text: string): Promise<{ value: Record<string, unknown>; from: string[] } | undefined> {
  let local: unknown;
  try {
    local = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(local) || !("extends" in local)) return undefined;
  const shown = (file: string) => relative(root, file).split(sep).join("/");
  const chain: string[] = [join(root, RUNTIME_FILE)];
  const layers: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = local;
  for (;;) {
    const { extends: target, ...own } = current;
    // The extended file's `$schema` names that file's kind; the folder's own file has none.
    if (layers.length > 0) delete own.$schema;
    layers.push(own);
    if (target === undefined) break;
    const from = chain.at(-1)!;
    if (typeof target !== "string" || target.trim() === "")
      throw new FolderError(root, `${shown(from)}: extends is the path of a JSON file, such as "../../platform/pod.runtime.json"`);
    const file = resolve(dirname(from), target);
    if (chain.includes(file))
      throw new FolderError(root, `${RUNTIME_FILE}: extends makes a cycle: ${[...chain, file].map(shown).join(" → ")}`);
    let body: string;
    try {
      body = await readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new FolderError(
        root,
        code === "ENOENT"
          ? `${shown(from)}: extends ${target}, which does not exist (${file})`
          : `${shown(from)}: cannot read ${target}, which it extends: ${code ?? error}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new FolderError(root, `${shown(file)}, which ${shown(from)} extends, is not JSON: ${(error as Error).message}`);
    }
    if (!isObject(parsed)) throw new FolderError(root, `${shown(file)}, which ${shown(from)} extends, is not a JSON object`);
    chain.push(file);
    current = parsed;
  }
  // The farthest file first, each nearer one over it.
  const value = layers.reduceRight<Record<string, unknown>>((under, layer) => merge(under, layer), {});
  return { value, from: chain.slice(1) };
}

/** Lists the agent folder at `dir` with each file's size and SHA-256. */
export async function packFolder(dir: string): Promise<PackedFolder> {
  const root = resolve(dir);
  const entries: AgentFolderEntry[] = [];
  const files = new Map<string, SkillFileSource>();
  const skipped: string[] = [];
  const ignoreText = await readFile(join(root, FOLDER_IGNORE_FILE), "utf8").catch(() => undefined);
  const ignored = ignoreText === undefined ? () => false : ignoreMatcher(ignoreText);
  let bytes = 0;
  const walk = async (at: string): Promise<void> => {
    const children = await readdir(at, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      throw new FolderError(root, `Cannot read ${at}: ${error.code ?? error}`);
    });
    for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(at, child.name);
      const path = relative(root, full).split(sep).join("/");
      if (child.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(child.name) && !ignored(path, true)) await walk(full);
        continue;
      }
      if (ignored(path)) continue;
      if (child.isSymbolicLink()) {
        skipped.push(`${path}: a symbolic link, not followed`);
        continue;
      }
      if (!child.isFile()) continue;
      if (entries.length >= AGENT_FOLDER_LIMITS.files)
        throw new FolderError(root, `${dir} holds more than ${AGENT_FOLDER_LIMITS.files} files, an agent folder's limit`);
      const data = await readFile(full);
      bytes += data.byteLength;
      if (bytes > AGENT_FOLDER_LIMITS.totalBytes)
        throw new FolderError(root, `${dir} holds more than ${AGENT_FOLDER_LIMITS.totalBytes} bytes, an agent folder's limit`);
      entries.push({ path, size: data.byteLength, sha256: sha256(data) });
      files.set(path, { size: data.byteLength, read: () => readFile(full) });
    }
  };
  await walk(root);

  // `extends`: the packed runtime.json is the merge, and origin.json names what it came from.
  let extended: string[] | undefined;
  const runtime = files.get(RUNTIME_FILE);
  if (runtime && runtime.size <= AGENT_FOLDER_LIMITS.textFileBytes) {
    const resolved = await resolveExtends(root, new TextDecoder().decode(await runtime.read()));
    if (resolved) {
      extended = resolved.from;
      const put = (path: string, text: string) => {
        const data = new TextEncoder().encode(text);
        const at = entries.findIndex((entry) => entry.path === path);
        const entry = { path, size: data.byteLength, sha256: sha256(data) };
        if (at < 0) entries.push(entry);
        else entries[at] = entry;
        files.set(path, { size: data.byteLength, read: async () => data });
      };
      put(RUNTIME_FILE, `${JSON.stringify(resolved.value, null, 2)}\n`);
      const relativeTo = (file: string) => relative(root, file).split(sep).join("/");
      put(ORIGIN_FILE, `${JSON.stringify({ [RUNTIME_FILE]: { extends: resolved.from.map(relativeTo) } }, null, 2)}\n`);
    }
  }
  entries.sort(byPath);
  return { dir: root, entries, files, skipped, ...(extended ? { extended } : {}) };
}
