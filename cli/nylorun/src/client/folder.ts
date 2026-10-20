/**
 * Agent folders (track T6, D79) on the command line, offline: `nylorun check [dir…]` compiles each
 * agent folder with the compiler the Runtime runs (`@nylorun/core/folder`) and prints every
 * diagnostic by file, line and column (`--json` for CI); `nylorun init <path>` (`init.ts`) writes
 * a new folder. Neither reads a Runtime. `nylorun apply` saves a folder (`apply.ts`).
 */
import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  AGENT_FOLDER_FILE,
  FolderError,
  checkFolder,
  diagnosticLine,
  isAgentFolder,
  packFolder,
  type PackedFolder,
} from "@nylorun/agents";
import type { AgentFolderDiagnostic } from "@nylorun/core/folder";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { usageError } from "./runtime.js";

export { initCommand, initUsage } from "./init.js";

export const checkUsage = `nylorun check [<dir>...] [--json]

Compiles each agent folder (default .) offline, with the compiler the Runtime runs, and prints
every problem by file, line and column. A folder holds AGENT.md; a folder without one checks each
subfolder that has one. Exits 1 when a folder does not compile. Reads no Runtime.

  --json                              print { "folders": [{ path, ok, manifest?, diagnostics }] }
                                      for CI: whether each folder compiles, the manifest it
                                      compiles to, and every diagnostic`;

/** The agent folders under `dir`: `dir` when it holds an `AGENT.md`, else each subfolder that does. */
export async function agentFolders(dir: string): Promise<string[]> {
  const root = resolve(dir);
  if (await isAgentFolder(root)) return [root];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1)))
    if (await isAgentFolder(join(root, entry.name))) found.push(join(root, entry.name));
  return found;
}

/** Packs the folder, or a `CliError` naming why it cannot be. */
export async function packed(folder: string): Promise<PackedFolder> {
  return packFolder(folder).catch((error: unknown) => {
    if (error instanceof FolderError) throw new CliError(error.message, 1);
    throw error;
  });
}

/** A folder's diagnostics as lines, each path relative to `cwd`. */
export function diagnosticLines(folder: string, cwd: string, diagnostics: readonly AgentFolderDiagnostic[]): string[] {
  const prefix = relative(cwd, folder);
  return diagnostics.map((item) =>
    diagnosticLine(item.file && prefix ? { ...item, file: `${prefix}/${item.file}` } : item),
  );
}

/** One folder in `check --json`. */
interface FolderReport {
  path: string;
  ok: boolean;
  manifest?: unknown;
  diagnostics: readonly AgentFolderDiagnostic[];
  skipped?: readonly string[];
}

/** `nylorun check [dir…] [--json]` */
export async function checkCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--json"] }, checkUsage);
  const json = flags.booleans.has("--json");
  const cwd = deps.cwd ?? process.cwd();
  const folders: string[] = [];
  for (const dir of flags.rest.length > 0 ? flags.rest : ["."]) {
    const found = await agentFolders(resolve(cwd, dir));
    if (found.length === 0) throw usageError(`${dir} holds no ${AGENT_FOLDER_FILE}, and no subfolder does.`);
    folders.push(...found);
  }
  let failed = false;
  const report: FolderReport[] = [];
  for (const folder of folders) {
    const pack = await packed(folder);
    const compiled = await checkFolder(pack);
    if (!compiled.manifest) failed = true;
    if (json) {
      report.push({
        path: relative(cwd, folder) || ".",
        ok: compiled.manifest !== undefined,
        ...(compiled.manifest ? { manifest: compiled.manifest } : {}),
        diagnostics: compiled.diagnostics,
        ...(pack.skipped.length > 0 ? { skipped: pack.skipped } : {}),
      });
      continue;
    }
    for (const skipped of pack.skipped) deps.err(`${relative(cwd, folder) || "."}: skipped ${skipped}`);
    for (const line of diagnosticLines(folder, cwd, compiled.diagnostics))
      if (compiled.manifest) deps.out(line);
      else deps.err(line);
    const label = relative(cwd, folder) || basename(folder);
    const files = `${pack.entries.length} ${pack.entries.length === 1 ? "file" : "files"}`;
    if (compiled.manifest) deps.out(`${label}: ok, agent manifest ${compiled.manifest.name} (${files}, ${compiled.compiler})`);
    else {
      const errors = compiled.diagnostics.filter((item) => item.severity === "error").length;
      deps.err(`${label}: ${errors} ${errors === 1 ? "error" : "errors"}`);
    }
  }
  if (json) deps.out(JSON.stringify({ folders: report }, null, 2));
  return failed ? 1 : 0;
}
