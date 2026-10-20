/**
 * `checkFolder`: compiles an agent folder offline with the compiler the Runtime runs
 * (`@nylorun/core/folder`). Its YAML parser loads Node modules, so the client entry imports this
 * module only when a folder is sent.
 */
import {
  AGENT_FOLDER_LIMITS,
  compileAgentFolder,
  folderTextPaths,
  type CompiledAgentFolder,
} from "@nylorun/core/folder";
import type { PackedFolder } from "./folder.js";

/**
 * Compiles a packed folder offline, as the Runtime will: the manifest when it compiles, and every
 * diagnostic either way. With `name`, the name it will be saved as, `AGENT.md`'s must match.
 */
export async function checkFolder(packed: PackedFolder, options: { name?: string } = {}): Promise<CompiledAgentFolder> {
  const text = new Map<string, Uint8Array>();
  for (const path of folderTextPaths(packed.entries)) {
    const source = packed.files.get(path)!;
    // The compiler reports a file over its limit; it needs no bytes for it.
    if (source.size <= AGENT_FOLDER_LIMITS.textFileBytes) text.set(path, await source.read());
  }
  return compileAgentFolder({ entries: packed.entries, files: text, ...(options.name === undefined ? {} : { name: options.name }) });
}
