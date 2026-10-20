/**
 * Packing an agent folder (track T6): `packFolder(dir)` lists every file with its size and SHA-256
 * and reads its bytes on demand. It skips `.git`, `.hg`, `.svn` and `node_modules` and follows no
 * symbolic link. Node only: it reads the folder.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { AGENT_FOLDER_LIMITS, type AgentFolderEntry } from "@nylorun/core/folder";
import type { SkillFileSource } from "@nylorun/core/define";
import { AGENT_FOLDER_FILE, FolderError, type PackedFolder } from "./folder.js";

const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

/** Whether `dir` holds an `AGENT.md`. */
export async function isAgentFolder(dir: string): Promise<boolean> {
  return stat(join(dir, AGENT_FOLDER_FILE)).then(
    (found) => found.isFile(),
    () => false,
  );
}

/** Lists the agent folder at `dir` with each file's size and SHA-256. */
export async function packFolder(dir: string): Promise<PackedFolder> {
  const root = resolve(dir);
  const entries: AgentFolderEntry[] = [];
  const files = new Map<string, SkillFileSource>();
  const skipped: string[] = [];
  let bytes = 0;
  const walk = async (at: string): Promise<void> => {
    const children = await readdir(at, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      throw new FolderError(root, `Cannot read ${at}: ${error.code ?? error}`);
    });
    for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(at, child.name);
      const path = relative(root, full).split(sep).join("/");
      if (child.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(child.name)) await walk(full);
        continue;
      }
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
      entries.push({ path, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
      files.set(path, { size: data.byteLength, read: () => readFile(full) });
    }
  };
  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir: root, entries, files, skipped };
}

