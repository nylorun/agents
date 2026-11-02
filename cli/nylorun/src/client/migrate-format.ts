/**
 * `nylorun migrate folder <dir> --to 2` (ADR-100): makes an `agent-folder/1` folder an
 * `agent-folder/2` one, in place, declaring every engine feature it gets today by default, so no
 * prompt and no tool changes until the author removes a line:
 *
 * - `format: agent-folder/2`;
 * - `engine:` in `AGENT.md` and in each `agents/<id>/AGENT.md`: the six sandbox tools,
 *   `save_artifact` and the outputs folder when the runtime has a computer, `read_artifact`
 *   always, and tool search.
 *
 * It checks the folder before and after, offline, with the compiler the Runtime runs, and that
 * every agent's system text and tool list are the same (`previewTurn`), and writes nothing when
 * they are not. Reads no Runtime.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { AGENT_FOLDER_FILE, checkFolder } from "@nylorun/agents";
import { SANDBOX_TOOL_NAMES } from "@nylorun/core/define";
import { previewTurn, runtimeToolOf } from "@nylorun/core/engine";
import { folderV3Edit } from "@nylorun/core/folder";
import type { AgentManifestV8 } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import { diagnosticLines, packed } from "./folder.js";
import { usageError } from "./runtime.js";

export const migrateFormatUsage = `nylorun migrate folder <dir> --to 2|3

Makes the agent folder <dir> agent-folder/2, in place: it adds format: agent-folder/2 to its
AGENT.md, and to it and each subagent's AGENT.md the engine: block that declares every engine
feature the folder gets today by default (the sandbox tools, save_artifact and the outputs folder
when runtime.json has a computer, read_artifact, tool search). Nothing the model reads or may
call changes, which it checks before it writes; then remove the lines the agent does not need.

With --to 3, makes an agent-folder/2 folder agent-folder/3 (ADR-105): the Runtime's plugins
(plugins: [nylorun-memory, ...]) in place of memory, loop, runtime.selfWake and engine's
sandbox, artifacts and triggers, with mcpServers.nylorun turning off the tools the folder left
out, and memory's instructions moved to the end of AGENT.md's body. Every agent keeps the same
tools and features, which it checks before it writes; the words the model reads become the
plugins'. Reads no Runtime.`;

/** The `engine:` block that keeps what an agent-folder/1 agent gets, as YAML lines. */
export function engineLines(computer: boolean): string[] {
  return computer
    ? [
        "engine:",
        `  sandbox: [${SANDBOX_TOOL_NAMES.join(", ")}]`,
        "  artifacts: { read: true, save: true }",
        "  outputs: true",
        "  toolSearch: true",
      ]
    : ["engine:", "  artifacts: { read: true, save: false }", "  toolSearch: true"];
}

/**
 * `text`, an `AGENT.md`, with `lines` added at the end of its frontmatter and, when `format` is
 * set, its `format:` line replaced by `format: <format>` (first in the frontmatter when it had
 * none). Undefined when it has no frontmatter.
 */
export function withFrontmatter(text: string, lines: readonly string[], format?: string): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const all = text.slice(bom.length).split(/\r?\n/);
  if (all[0]?.trimEnd() !== "---") return undefined;
  const end = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return undefined;
  let front = all.slice(1, end);
  if (format !== undefined) {
    const at = front.findIndex((line) => /^format\s*:/.test(line));
    if (at >= 0) front[at] = `format: ${format}`;
    else front = [`format: ${format}`, ...front];
  }
  return bom + ["---", ...front, ...lines, ...all.slice(end)].join(eol);
}

/** What each agent of a compiled folder reads and may call, by agent, for a comparison. */
function seen(manifest: AgentManifestV8): string {
  if ("kind" in manifest.harness) return "";
  const preview = previewTurn(manifest);
  const one = (item: { system: string; tools: readonly unknown[] }) => ({ system: item.system, tools: item.tools });
  return JSON.stringify({ root: one(preview), pinned: preview.pinned, agents: Object.fromEntries(Object.entries(preview.agents).map(([id, item]) => [id, one(item)])) });
}

/** What each agent of a compiled folder may call, by the effects of its tools, and what is pinned. */
function effects(manifest: AgentManifestV8): string {
  if ("kind" in manifest.harness) return "";
  const preview = previewTurn(manifest);
  // The skill tools come with the plugins' skills (memory, triggers), so they are left out here.
  const skillTools = new Set(["load_skill", "read_skill_resource"]);
  const tools = (item: { tools: readonly { name: string }[] }) =>
    item.tools
      .map((tool) => runtimeToolOf(tool.name) ?? tool.name)
      .filter((name) => !skillTools.has(name))
      .sort();
  return JSON.stringify({ root: tools(preview), pinned: preview.pinned.length, agents: Object.fromEntries(Object.entries(preview.agents).map(([id, item]) => [id, tools(item)])) });
}

/** `nylorun migrate folder <dir> --to 3` (ADR-105). */
async function migrateToV3(deps: StackDeps, dir: string): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const where = relative(cwd, dir) || ".";
  const before = await checkFolder(await packed(dir));
  if (!before.manifest) {
    for (const line of diagnosticLines(dir, cwd, before.diagnostics)) deps.err(line);
    throw new CliError(`${where} does not compile: fix it first (nylorun check ${where}).`, 1);
  }
  if (before.compiler === "agent-folder/3") {
    deps.out(`${where} is agent-folder/3 already: nothing to do.`);
    return 0;
  }
  if (before.compiler !== "agent-folder/2") throw new CliError(`${where} is ${before.compiler}: migrate it to agent-folder/2 first (nylorun migrate folder ${where} --to 2).`, 1);
  const harness = before.manifest.harness;
  if ("kind" in harness) throw new CliError(`${where} is a flow: migrate each agent folder it holds instead.`, 1);
  const read = async (path: string) => readFile(join(dir, ...path.split("/")), "utf8");
  const edits = new Map<string, string>();
  const runtimeJson = await read("runtime.json").catch(() => undefined);
  const root = folderV3Edit({ agentMd: await read(AGENT_FOLDER_FILE), ...(runtimeJson === undefined ? {} : { runtimeJson }), role: "root" });
  if (!root.ok) throw new CliError(`${join(where, AGENT_FOLDER_FILE)}: ${root.reason}.`, 1);
  edits.set(AGENT_FOLDER_FILE, root.agentMd);
  if (root.runtimeJson !== undefined && root.runtimeJson !== runtimeJson) edits.set("runtime.json", root.runtimeJson);
  for (const tool of harness.tools ?? []) {
    if (!tool.agent) continue;
    const path = `agents/${tool.name}/${AGENT_FOLDER_FILE}`;
    const edited = folderV3Edit({ agentMd: await read(path), role: "subagent" });
    if (!edited.ok) throw new CliError(`${join(where, path)}: ${edited.reason}.`, 1);
    edits.set(path, edited.agentMd);
  }
  const pack = await packed(dir);
  const encoder = new TextEncoder();
  const files = new Map(pack.files);
  const entries = pack.entries.map((entry) => {
    const text = edits.get(entry.path);
    if (text === undefined) return entry;
    const bytes = encoder.encode(text);
    const source = files.get(entry.path)!;
    files.set(entry.path, { ...source, size: bytes.byteLength, read: async () => bytes });
    return { ...entry, size: bytes.byteLength, sha256: sha256Hex(bytes) };
  });
  const after = await checkFolder({ ...pack, entries, files });
  if (!after.manifest) {
    for (const line of diagnosticLines(dir, cwd, after.diagnostics)) deps.err(line);
    throw new CliError(`${where} would not compile as agent-folder/3: nothing was written.`, 1);
  }
  if (effects(after.manifest) !== effects(before.manifest))
    throw new CliError(`${where} as agent-folder/3 would change what its agents may call: nothing was written.`, 1);
  for (const [path, text] of edits) await writeFile(join(dir, ...path.split("/")), text);
  for (const path of edits.keys()) deps.out(`wrote ${join(where, path)}`);
  deps.out(
    `${where} is agent-folder/3: its agents keep their tools, now named nylorun__<tool>, with the plugins' words. Check what each gets with nylorun check --explain ${where}, and update instructions that name the tools.`,
  );
  return 0;
}

/** `nylorun migrate folder <dir> --to 2|3` */
export async function migrateFormatCommand(deps: StackDeps, dir: string, to: string): Promise<number> {
  if (to === "3" || to === "agent-folder/3") return migrateToV3(deps, dir);
  if (to !== "2" && to !== "agent-folder/2") throw usageError(`--to takes 2 (agent-folder/2) or 3 (agent-folder/3).\n${migrateFormatUsage}`);
  const cwd = deps.cwd ?? process.cwd();
  const where = relative(cwd, dir) || ".";
  const before = await checkFolder(await packed(dir));
  if (!before.manifest) {
    for (const line of diagnosticLines(dir, cwd, before.diagnostics)) deps.err(line);
    throw new CliError(`${where} does not compile: fix it first (nylorun check ${where}).`, 1);
  }
  if (before.compiler === "agent-folder/2") {
    deps.out(`${where} is agent-folder/2 already: nothing to do.`);
    return 0;
  }
  const harness = before.manifest.harness;
  if ("kind" in harness) throw new CliError(`${where} is a flow: migrate each agent folder it holds instead.`, 1);
  const kind = before.manifest.runtime?.kind ?? "none";
  const computer = kind === "virtual" || kind === "pod";
  // The root, then each subagent (`agents/<id>/`), each with the declarations it gets today.
  const edits = new Map<string, string>();
  const read = async (path: string) => readFile(join(dir, ...path.split("/")), "utf8");
  const root = withFrontmatter(await read(AGENT_FOLDER_FILE), engineLines(computer), "agent-folder/2");
  if (root === undefined) throw new CliError(`${join(where, AGENT_FOLDER_FILE)} has no frontmatter.`, 1);
  edits.set(AGENT_FOLDER_FILE, root);
  for (const tool of harness.tools ?? []) {
    if (!tool.agent) continue;
    const path = `agents/${tool.name}/${AGENT_FOLDER_FILE}`;
    const edited = withFrontmatter(await read(path), engineLines(computer));
    if (edited === undefined) throw new CliError(`${join(where, path)} has no frontmatter.`, 1);
    edits.set(path, edited);
  }
  // The folder as it would be, compiled and compared before anything is written.
  const pack = await packed(dir);
  const encoder = new TextEncoder();
  const files = new Map(pack.files);
  const entries = pack.entries.map((entry) => {
    const text = edits.get(entry.path);
    if (text === undefined) return entry;
    const bytes = encoder.encode(text);
    const source = files.get(entry.path)!;
    files.set(entry.path, { ...source, size: bytes.byteLength, read: async () => bytes });
    return { ...entry, size: bytes.byteLength, sha256: sha256Hex(bytes) };
  });
  const after = await checkFolder({ ...pack, entries, files });
  if (!after.manifest) {
    for (const line of diagnosticLines(dir, cwd, after.diagnostics)) deps.err(line);
    throw new CliError(`${where} would not compile as agent-folder/2: nothing was written.`, 1);
  }
  if (seen(after.manifest) !== seen(before.manifest))
    throw new CliError(`${where} as agent-folder/2 would change what its model reads or may call: nothing was written.`, 1);
  for (const [path, text] of edits) await writeFile(join(dir, ...path.split("/")), text);
  for (const path of edits.keys()) deps.out(`wrote ${join(where, path)}`);
  deps.out(
    `${where} is agent-folder/2, and its agents get what they got before. Remove the engine features they do not use, and see what each adds with nylorun check --explain ${where}.`,
  );
  return 0;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
