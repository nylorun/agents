/**
 * Agent folders (track T6, D79) on the command line, offline: `nylorun check [dir…]` compiles each
 * agent folder with the compiler the Runtime runs (`@nylorun/core/folder`) and prints every
 * diagnostic by file, line and column (`--json` for CI), and `--fix` makes the edits the fixable
 * ones carry (track T7); `nylorun init <path>` (`init.ts`) writes a new folder. Neither reads a
 * Runtime. `nylorun apply` saves a folder (`apply.ts`).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
import { applyFolderFixes, type AgentFolderDiagnostic, type AgentFolderFix } from "@nylorun/core/folder";
import { explainEngine, type ExplainedAgent } from "@nylorun/core/engine";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { usageError } from "./runtime.js";

export { initCommand, initUsage } from "./init.js";

export const checkUsage = `nylorun check [<dir>...] [--fix] [--explain] [--json]

Compiles each agent folder (default .) offline, with the compiler the Runtime runs, and prints
every problem by file, line and column. A folder holds AGENT.md; a folder without one checks each
subfolder that has one. Exits 1 when a folder does not compile. Reads no Runtime.

A problem one edit fixes says (fixable with --fix): an unknown key with one did-you-mean, CRLF
line ends, and secrets in a SKILL.md, which go in AGENT.md's skills block.

  --fix                               make those edits in the folder's files, print each, then
                                      check again; nothing is written without it, and a file
                                      that changed since it was checked is left as it is
  --explain                           print each engine feature the agent and its subagents get
                                      (agent-folder/2 declares them; agent-folder/1 gets them all
                                      by default), with the tools and text blocks each adds
  --json                              print { "folders": [{ path, ok, manifest?, diagnostics }] }
                                      for CI: whether each folder compiles, the manifest it
                                      compiles to, and every diagnostic, each fixable one with
                                      its fix; with --fix, also what was fixed and what was not;
                                      with --explain, the features as explain`;

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

/** A folder's diagnostics as lines, each path relative to `cwd`; `fixable` marks those with a fix. */
export function diagnosticLines(folder: string, cwd: string, diagnostics: readonly AgentFolderDiagnostic[], fixable = false): string[] {
  const prefix = relative(cwd, folder);
  return diagnostics.map(
    (item) => diagnosticLine(item.file && prefix ? { ...item, file: `${prefix}/${item.file}` } : item) + (fixable && item.fix ? " (fixable with --fix)" : ""),
  );
}

/** What `check --fix` did to one folder: each change by file, and each fix not made, with why. */
interface Fixed {
  readonly fixed: readonly { readonly file: string; readonly change: string }[];
  readonly unfixed: readonly { readonly file: string; readonly reason: string }[];
}

/** How many times `check --fix` fixes and checks one folder, at most. */
const FIX_ROUNDS = 5;

const sha256Hex =(bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/**
 * Makes the fix-its `diagnostics` carry in the folder's files (`applyFolderFixes`). A file is
 * edited only when its bytes on disk are the ones checked, and written only when they still are:
 * when one has changed by then, nothing is written.
 */
async function fixFolder(pack: PackedFolder, diagnostics: readonly AgentFolderDiagnostic[], cwd: string): Promise<Fixed> {
  const fixes = diagnostics.flatMap((item) => (item.fix ? [item.fix] : []));
  if (fixes.length === 0) return { fixed: [], unfixed: [] };
  const filesOf = (fix: AgentFolderFix) => (fix.kind === "move_skill_secrets" ? [fix.file, AGENT_FOLDER_FILE] : [fix.file]);
  const read = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const unreadable = new Map<string, string>();
  for (const path of new Set(fixes.flatMap(filesOf))) {
    if (path === "runtime.json" && pack.extended) {
      unreadable.set(path, "runtime.json extends another file, and was checked merged with it: fix it by hand");
      continue;
    }
    const entry = pack.entries.find((item) => item.path === path);
    const bytes = entry
      ? await readFile(join(pack.dir, ...path.split("/"))).then(
          (data) => new Uint8Array(data),
          () => undefined,
        )
      : undefined;
    if (!entry || !bytes || sha256Hex(bytes) !== entry.sha256) {
      unreadable.set(path, "the file changed since it was checked: check again");
      continue;
    }
    read.set(path, bytes);
    // A byte-order mark stays: the fixes keep it.
    texts.set(path, new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
  }
  const unfixed: { file: string; reason: string }[] = [];
  const applicable = fixes.filter((fix) => {
    const blocked = filesOf(fix).find((path) => unreadable.has(path));
    if (blocked) unfixed.push({ file: fix.file, reason: unreadable.get(blocked)! });
    return !blocked;
  });
  const result = applyFolderFixes(texts, applicable);
  unfixed.push(...result.skipped.map(({ fix, reason }) => ({ file: fix.file, reason })));
  const encoder = new TextEncoder();
  const writes = [...result.files].map(([path, text]) => ({ target: join(pack.dir, ...path.split("/")), before: read.get(path)!, after: encoder.encode(text) }));
  for (const { target, before } of writes)
    if (!sameBytes(new Uint8Array(await readFile(target)), before))
      throw new CliError(`${relative(cwd, target)} changed while it was being fixed: nothing was written. Check again.`, 1);
  for (const { target, after } of writes) await writeFile(target, after);
  return { fixed: result.changes, unfixed };
}

/** `check --explain`'s lines for one folder: each agent, then each feature, on or off. */
export function explainLines(agents: readonly ExplainedAgent[]): string[] {
  const lines: string[] = [];
  for (const agent of agents) {
    lines.push(`  ${agent.agent}: ${agent.declared ? "declares its engine features (agent-folder/2)" : "every engine feature by default (agent-folder/1)"}`);
    for (const item of agent.features) {
      const adds = [
        ...(item.tools.length > 0 ? [`tools ${item.tools.join(", ")}`] : []),
        ...(item.blocks.length > 0 ? [`text ${item.blocks.join(", ")}`] : []),
        ...(item.note === undefined ? [] : [item.note]),
      ];
      lines.push(`    ${item.on ? "on " : "off"} ${item.feature} (${item.declaredBy})${item.on && adds.length > 0 ? `: ${adds.join("; ")}` : item.note && item.feature === "toolSearch" ? `: ${item.note}` : ""}`);
    }
  }
  return lines;
}

/** One folder in `check --json`. */
interface FolderReport {
  path: string;
  ok: boolean;
  manifest?: unknown;
  diagnostics: readonly AgentFolderDiagnostic[];
  skipped?: readonly string[];
  explain?: readonly ExplainedAgent[];
  fixed?: Fixed["fixed"];
  unfixed?: Fixed["unfixed"];
}

/** `nylorun check [dir…] [--fix] [--json]` */
export async function checkCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--json", "--fix", "--explain"] }, checkUsage);
  const json = flags.booleans.has("--json");
  const fix = flags.booleans.has("--fix");
  const explain = flags.booleans.has("--explain");
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
    let pack = await packed(folder);
    let compiled = await checkFolder(pack);
    const fixed: { fixed: Fixed["fixed"][number][]; unfixed: Fixed["unfixed"] } = { fixed: [], unfixed: [] };
    // Checked again after each round, so what is printed is the folder as it is now. The compiler
    // stops at a stage with errors, so a fix can show the next stage's: a few rounds take them.
    for (let round = 0; fix && round < FIX_ROUNDS; round++) {
      const made = await fixFolder(pack, compiled.diagnostics, cwd);
      fixed.fixed.push(...made.fixed);
      fixed.unfixed = made.unfixed;
      if (made.fixed.length === 0) break;
      pack = await packed(folder);
      compiled = await checkFolder(pack);
    }
    if (!compiled.manifest) failed = true;
    if (json) {
      report.push({
        path: relative(cwd, folder) || ".",
        ok: compiled.manifest !== undefined,
        ...(compiled.manifest ? { manifest: compiled.manifest } : {}),
        diagnostics: compiled.diagnostics,
        ...(pack.skipped.length > 0 ? { skipped: pack.skipped } : {}),
        ...(explain && compiled.manifest ? { explain: explainEngine(compiled.manifest) } : {}),
        ...(fix ? { fixed: fixed.fixed, unfixed: fixed.unfixed } : {}),
      });
      continue;
    }
    const shown = (file: string) => relative(cwd, join(folder, file));
    for (const item of fixed.fixed) deps.out(`fixed ${shown(item.file)}: ${item.change}`);
    for (const item of fixed.unfixed) deps.err(`not fixed ${shown(item.file)}: ${item.reason}`);
    for (const skipped of pack.skipped) deps.err(`${relative(cwd, folder) || "."}: skipped ${skipped}`);
    for (const line of diagnosticLines(folder, cwd, compiled.diagnostics, !fix))
      if (compiled.manifest) deps.out(line);
      else deps.err(line);
    const label = relative(cwd, folder) || basename(folder);
    const files = `${pack.entries.length} ${pack.entries.length === 1 ? "file" : "files"}`;
    if (compiled.manifest) deps.out(`${label}: ok, agent manifest ${compiled.manifest.name} (${files}, ${compiled.compiler})`);
    if (compiled.manifest && explain) for (const line of explainLines(explainEngine(compiled.manifest))) deps.out(line);
    else {
      const errors = compiled.diagnostics.filter((item) => item.severity === "error").length;
      deps.err(`${label}: ${errors} ${errors === 1 ? "error" : "errors"}`);
    }
  }
  if (json) deps.out(JSON.stringify({ folders: report }, null, 2));
  return failed ? 1 : 0;
}
