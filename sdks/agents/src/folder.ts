/**
 * Agent folders (track T6, D79): a folder of Markdown and JSON (`AGENT.md`, `mcp.json`,
 * `runtime.json`, `skills/`, `tools/`, `triggers/`, `files/`) that `@nylorun/core/folder`
 * compiles into agent manifest v8. `packFolder(dir)` (`folder-pack.ts`, Node only) lists it with
 * each file's size and hash, `checkFolder` compiles it offline with the same compiler the Runtime
 * runs, and `client.agentManifests.saveFolder` sends it by hash, so the Runtime keeps the folder
 * as the version's source. This module loads neither the file system nor the compiler, whose
 * YAML parser needs Node: the client entry loads it, and `checkFolder` (`folder-check.ts`) only
 * when a folder is sent.
 */
import type { AgentFolderDiagnostic, AgentFolderEntry } from "@nylorun/core/folder";
import type { SkillFileSource } from "@nylorun/core/define";

/** The file that makes a folder an agent folder. */
export const AGENT_FOLDER_FILE = "AGENT.md";

/** A folder as the Runtime takes it: each file's path, size and hash, and a way to read its bytes. */
export interface PackedFolder {
  /** The folder's absolute path. */
  readonly dir: string;
  /** Every file, sorted by path, with `/` between segments. */
  readonly entries: readonly AgentFolderEntry[];
  /** Each file's bytes, by path. */
  readonly files: ReadonlyMap<string, SkillFileSource>;
  /** What packing left out, and why (a symbolic link). */
  readonly skipped: readonly string[];
}

/** A folder that cannot be packed: too many files, or more bytes than an agent folder holds. */
export class FolderError extends Error {
  constructor(
    readonly dir: string,
    message: string,
  ) {
    super(message);
    this.name = "FolderError";
  }
}

/** A folder that does not compile; `diagnostics` holds every problem, by file, line and column. */
export class FolderInvalidError extends Error {
  constructor(
    readonly dir: string,
    readonly diagnostics: readonly AgentFolderDiagnostic[],
  ) {
    const errors = diagnostics.filter((item) => item.severity === "error");
    super(`Agent folder ${dir} does not compile:\n${errors.map((item) => `  ${diagnosticLine(item)}`).join("\n")}`);
    this.name = "FolderInvalidError";
  }
}

/** A diagnostic as a person reads it: `file:line:column severity message`. */
export function diagnosticLine(diagnostic: AgentFolderDiagnostic): string {
  const where = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""} `
    : "";
  return `${where}${diagnostic.severity}: ${diagnostic.message}`;
}
