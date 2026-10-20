/**
 * Agent folders (track T6, D79) on the command line, offline: `nylorun check [dir…]` compiles each
 * agent folder with the compiler the Runtime runs (`@nylorun/core/folder`) and prints every
 * diagnostic by file, line and column; `nylorun init <name>` writes a new folder's `AGENT.md`.
 * Neither reads a Runtime. `nylorun apply` saves a folder (`apply.ts`).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { isAgentManifestName } from "@nylorun/core/contracts";
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

export const checkUsage = `nylorun check [<dir>...]

Compiles each agent folder (default .) offline, with the compiler the Runtime runs, and prints
every problem by file, line and column. A folder holds AGENT.md; a folder without one checks each
subfolder that has one. Exits 1 when a folder does not compile. Reads no Runtime.`;

export const initUsage = `nylorun init <name> [--description <text>]

Writes <name>/AGENT.md, the smallest agent folder: frontmatter with its name and description, and
its instructions below. Save it with nylorun apply <name>.`;

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

/** `nylorun check [dir…]` */
export async function checkCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, {}, checkUsage);
  const cwd = deps.cwd ?? process.cwd();
  const folders: string[] = [];
  for (const dir of flags.rest.length > 0 ? flags.rest : ["."]) {
    const found = await agentFolders(resolve(cwd, dir));
    if (found.length === 0) throw usageError(`${dir} holds no ${AGENT_FOLDER_FILE}, and no subfolder does.`);
    folders.push(...found);
  }
  let failed = false;
  for (const folder of folders) {
    const pack = await packed(folder);
    const compiled = await checkFolder(pack);
    for (const skipped of pack.skipped) deps.err(`${relative(cwd, folder) || "."}: skipped ${skipped}`);
    for (const line of diagnosticLines(folder, cwd, compiled.diagnostics))
      if (compiled.manifest) deps.out(line);
      else deps.err(line);
    const label = relative(cwd, folder) || basename(folder);
    if (compiled.manifest) deps.out(`${label}: ok, agent manifest ${compiled.manifest.name} (${pack.entries.length} files, ${compiled.compiler})`);
    else {
      failed = true;
      const errors = compiled.diagnostics.filter((item) => item.severity === "error").length;
      deps.err(`${label}: ${errors} ${errors === 1 ? "error" : "errors"}`);
    }
  }
  return failed ? 1 : 0;
}

/** `nylorun init <name> [--description <text>]` */
export async function initCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { values: ["--description"] }, initUsage);
  const [name, ...rest] = flags.rest;
  if (name === undefined || rest.length > 0) throw usageError(`Usage: ${initUsage.split("\n")[0]}`);
  if (!isAgentManifestName(name))
    throw usageError(`${name} is not an agent's name: 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit.`);
  const dir = resolve(deps.cwd ?? process.cwd(), name);
  const file = join(dir, AGENT_FOLDER_FILE);
  if (existsSync(file)) throw new CliError(`${relative(deps.cwd ?? process.cwd(), file)} exists already.`, 1);
  const description = flags.values.get("--description") ?? `Describe what ${name} does in one sentence.`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nYou are ${name}. Write the agent's instructions here, in Markdown.\n`,
    { flag: "wx" },
  );
  deps.out(`Wrote ${relative(deps.cwd ?? process.cwd(), file)}. Check it with nylorun check ${name}, and save it with nylorun apply ${name}.`);
  return 0;
}
