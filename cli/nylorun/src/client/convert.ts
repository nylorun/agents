/**
 * Converting to agent folders (track T7, D80):
 *
 * - `nylorun export --folder <name>[@<version>]` writes the agent folder of a saved manifest, from
 *   JSON or TypeScript (`folderOfManifest`, `@nylorun/core/folder`), read with the Runtime API.
 * - `nylorun migrate folder <dir>` does the same, offline, for a three-file folder
 *   (`agent.manifest.json`), composed as `nylorun apply` composes it, with its skills' bytes.
 * - `nylorun pull <name>[@<version>]` writes back the folder a version was saved from, byte for
 *   byte, from the version's source (`agentManifests.source` and `sourceFile`).
 *
 * None writes over a file whose bytes differ: a file that is already there with the same bytes
 * is left as it is, and a conflict writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  AGENT_MANIFEST_FILE,
  ComposeError,
  PluginError,
  RuntimeError,
  SkillsError,
  composeManifest,
  type AgentsClient,
} from "@nylorun/agents";
import { isAgentManifestName } from "@nylorun/core/contracts";
import { folderOfManifest, type FolderOfManifest } from "@nylorun/core/folder";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { parseFlags, runtimeCall, runtimeClient, runtimeFlagsUsage, usageError } from "./runtime.js";

export const exportUsage = `nylorun export --folder <name>[@<version>] [--out <dir>]

Writes the agent folder of a saved agent manifest (its latest version, or <version>), for one
saved as JSON or from TypeScript: AGENT.md with its instructions, instructions/, tools/, mcp.json,
triggers/ and runtime.json. It says whether the folder compiles back to the same manifest, and
notes what it cannot write the same way. Skills' files and flows are not written: see the notes.

  --folder                            write an agent folder (the only export there is)
  --out <dir>                         where the folder goes (default ./<name>); no file is
                                      written over

${runtimeFlagsUsage}`;

export const migrateFolderUsage = `nylorun migrate folder <dir> [--out <dir>]

Writes the agent folder of the three-file folder <dir> (agent.manifest.json, with its
harness.manifest.json and runtime.manifest.json), offline: the manifest nylorun apply composes
from it, as AGENT.md, mcp.json, tools/, skills/ and runtime.json. A SKILL.md's secrets move to
AGENT.md. It says whether the folder compiles to the same manifest. Reads no Runtime.

  --out <dir>                         where the folder goes (default ./<name>); no file is
                                      written over`;

export const pullUsage = `nylorun pull <name>[@<version>] [--out <dir>]

Writes the agent folder a version of manifest <name> (default its latest) was saved from, byte
for byte, as the Runtime keeps it. A version saved as JSON has none: nylorun export --folder
writes one from its manifest.

  --out <dir>                         where the folder goes (default ./<name>); a file with the
                                      same bytes is left, and no file is written over

${runtimeFlagsUsage}`;

/** `name` or `name@version`. */
function nameAndVersion(ref: string, usage: string): { name: string; version?: number } {
  const at = ref.lastIndexOf("@");
  const name = at < 0 ? ref : ref.slice(0, at);
  const version = at < 0 ? undefined : ref.slice(at + 1);
  if (!isAgentManifestName(name)) throw usageError(`${name} is not an agent manifest's name.\nUsage: ${usage.split("\n")[0]}`);
  if (version !== undefined && !/^[1-9]\d{0,8}$/.test(version))
    throw usageError(`${ref}: the version after @ is a whole number from 1.\nUsage: ${usage.split("\n")[0]}`);
  return version === undefined ? { name } : { name, version: Number(version) };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/**
 * Writes `files` under `out`. A file already there with the same bytes is left; one with other
 * bytes is a conflict, and with any conflict nothing is written. Answers how many it wrote and left.
 */
export async function writeFolder(
  out: string,
  files: ReadonlyMap<string, Uint8Array | string>,
  cwd: string,
): Promise<{ written: number; same: number }> {
  const encoder = new TextEncoder();
  const plan: [string, Uint8Array][] = [];
  const conflicts: string[] = [];
  let same = 0;
  for (const [path, content] of files) {
    const target = resolve(out, path);
    if (!target.startsWith(`${out}${sep}`)) throw new CliError(`${path} would be written outside ${relative(cwd, out) || "."}: nothing was written.`, 1);
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    if (existsSync(target)) {
      if (sameBytes(new Uint8Array(await readFile(target)), bytes)) same++;
      else conflicts.push(relative(cwd, target));
      continue;
    }
    plan.push([target, bytes]);
  }
  if (conflicts.length > 0)
    throw new CliError(
      `${conflicts.length === 1 ? `${conflicts[0]} exists` : `These files exist: ${conflicts.join(", ")}`} with other bytes: nothing was written. Pass another --out, or move ${conflicts.length === 1 ? "it" : "them"} first.`,
      1,
    );
  for (const [target, bytes] of plan) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  return { written: plan.length, same };
}

/** "Wrote 3 files to triage" and, when some were there already, how many. */
function wroteLine(where: string, result: { written: number; same: number }): string {
  const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
  return `Wrote ${files(result.written)} to ${where}${result.same > 0 ? ` (${files(result.same)} already there, the same)` : ""}.`;
}

/** The folder written, then what differs from the manifest, then the next step. */
async function writeDecompiled(
  deps: StackDeps,
  folder: FolderOfManifest,
  out: string,
  cwd: string,
  what: string,
): Promise<number> {
  if (folder.files.size === 0) throw new CliError(`${what} gives no agent folder:\n${folder.notes.map((note) => `  ${note}`).join("\n")}`, 1);
  const where = relative(cwd, out) || ".";
  deps.out(wroteLine(where, await writeFolder(out, folder.files, cwd)));
  for (const note of folder.notes) deps.err(`  note: ${note}`);
  deps.err(
    folder.exact
      ? `It compiles back to the same manifest. Check it with nylorun check ${where}, and save it with nylorun apply ${where}.`
      : `It compiles to a different manifest: see the notes, then check it with nylorun check ${where}.`,
  );
  return 0;
}

/** `nylorun export --folder <name>[@<version>] [--out <dir>]` */
export async function exportCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = exportUsage.split("\n")[0]!;
  const flags = parseFlags(args, { booleans: ["--folder"], values: ["--out"] }, exportUsage);
  if (!flags.booleans.has("--folder")) throw usageError(`nylorun export writes an agent folder: pass --folder.\nUsage: ${usage}`);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const { name, version } = nameAndVersion(flags.rest[0]!, exportUsage);
  const cwd = deps.cwd ?? process.cwd();
  const { client } = await runtimeClient(deps, flags);
  const view = await runtimeCall(() => client.agentManifests.get(name, version));
  if (view.source)
    deps.err(`${name}@${view.version} was saved from a folder: nylorun pull ${name}@${view.version} writes it as it was saved.`);
  const out = resolve(cwd, flags.values.get("--out") ?? name);
  return writeDecompiled(deps, folderOfManifest(view.manifest), out, cwd, `${name}@${view.version}`);
}

/** What a three-file folder could not be composed for, as a person reads it. */
function composeFailure(dir: string, error: unknown): never {
  if (error instanceof ComposeError || error instanceof SkillsError || error instanceof PluginError || error instanceof TypeError)
    throw new CliError(`${dir}: ${error.message}`, 1);
  throw error;
}

/** `nylorun migrate folder <dir> [--out <dir>]` */
export async function migrateFolderCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { values: ["--out"] }, migrateFolderUsage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${migrateFolderUsage.split("\n")[0]}`);
  const cwd = deps.cwd ?? process.cwd();
  const dir = resolve(cwd, flags.rest[0]!);
  if (!existsSync(join(dir, AGENT_MANIFEST_FILE))) throw usageError(`${flags.rest[0]} holds no ${AGENT_MANIFEST_FILE}.`);
  const composed = await composeManifest(dir).catch((error: unknown) => composeFailure(flags.rest[0]!, error));
  const out = resolve(cwd, flags.values.get("--out") ?? composed.manifest.name);
  if (out === dir) throw usageError(`The folder would be written over the three files in ${relative(cwd, dir) || "."}: pass --out.`);
  // The bytes behind the manifest's hashes, so its skills and runtime files are written as files.
  const bytes = new Map<string, Uint8Array>();
  for (const [hash, source] of composed.files) bytes.set(hash, await source.read());
  // This command is what the deprecation warning names.
  for (const warning of composed.warnings.filter((item) => !item.includes("nylorun migrate folder"))) deps.err(`  warning: ${warning}`);
  for (const gap of composed.gaps) deps.err(`  fix before apply: ${gap}`);
  return writeDecompiled(deps, folderOfManifest(composed.manifest, { files: bytes }), out, cwd, relative(cwd, dir) || ".");
}

/** The source of `name@version`, or a `CliError` that says a JSON save has none. */
async function sourceOf(client: AgentsClient, name: string, version: number) {
  try {
    return await client.agentManifests.source(name, version);
  } catch (error) {
    if (error instanceof RuntimeError && error.status === 404 && (error.body as { code?: unknown } | undefined)?.code !== "manifest_not_found")
      throw new CliError(
        `${name}@${version} was saved as JSON, not from a folder, so it has no source. nylorun export --folder ${name}@${version} writes a folder from its manifest.`,
        1,
      );
    return runtimeCall(() => Promise.reject(error));
  }
}

/** `nylorun pull <name>[@<version>] [--out <dir>]` */
export async function pullCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { values: ["--out"] }, pullUsage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${pullUsage.split("\n")[0]}`);
  const ref = nameAndVersion(flags.rest[0]!, pullUsage);
  const cwd = deps.cwd ?? process.cwd();
  const { client } = await runtimeClient(deps, flags);
  const version = ref.version ?? (await runtimeCall(() => client.agentManifests.get(ref.name))).version;
  const source = await sourceOf(client, ref.name, version);
  const files = new Map<string, Uint8Array>();
  for (const entry of source.entries) {
    const bytes = await runtimeCall(() => client.agentManifests.sourceFile(ref.name, version, entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new CliError(`${entry.path} came back with other bytes than the source lists: nothing was written. Pull again.`, 1);
    files.set(entry.path, bytes);
  }
  const out = resolve(cwd, flags.values.get("--out") ?? ref.name);
  const where = relative(cwd, out) || ".";
  deps.out(wroteLine(where, await writeFolder(out, files, cwd)));
  deps.err(`${ref.name}@${version}, compiled by ${source.compiler}. Check it with nylorun check ${where}, and save an edit with nylorun apply ${where}.`);
  return 0;
}
