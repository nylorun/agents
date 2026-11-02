/**
 * `agent-folder/2` → `agent-folder/3` (ADR-106): the plugins that keep what an agent gets, written
 * in place of the declarations they stand for. `nylorun migrate folder <dir> --to 3` runs it on a
 * folder's `AGENT.md` and each subagent's, and on `runtime.json`, then checks that every agent
 * keeps the same tools and features.
 *
 * - `memory` → `nylorun-memory`; its `instructions` move to the end of the body.
 * - `engine.triggers`, or `runtime.selfWake` → `nylorun-triggers`.
 * - `loop.plan` → `nylorun-plan`; `loop.connections` → `nylorun-interactions`, with `ask` off.
 * - `engine.artifacts` → `nylorun-artifacts`, with the tools it left out off.
 * - `engine.sandbox` → `nylorun-sandbox`, with the tools it left out off.
 *
 * A declaration v3 can't express stops it: a read-only root memory, `memory.index: false`, or a
 * replaced wording (`engine.instructions`).
 */
import { Document, isMap, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";
import { RUNTIME_SERVER, pluginTools, type PluginName } from "../plugins/index.js";
import { AGENT_FOLDER_V3 } from "./v3.js";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A folder file, migrated, or why it can't be. */
export type FolderV3Edit =
  | { readonly ok: true; readonly agentMd: string; readonly runtimeJson?: string; readonly plugins: readonly PluginName[] }
  | { readonly ok: false; readonly reason: string };

function split(text: string): { front: string; body: string; eol: string } | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return undefined;
  return { front: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n"), eol };
}

/**
 * Migrates one `AGENT.md` (and, for the root, its folder's `runtime.json`). `role` is `subagent`
 * for `agents/<id>/AGENT.md`, which declares no memory, loop or triggers of its own.
 */
export function folderV3Edit(input: { readonly agentMd: string; readonly runtimeJson?: string; readonly role: "root" | "subagent" }): FolderV3Edit {
  const parts = split(input.agentMd);
  if (!parts) return { ok: false, reason: "AGENT.md has no frontmatter" };
  const doc = parseDocument(parts.front);
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const runtime = input.runtimeJson === undefined ? undefined : (JSON.parse(input.runtimeJson) as Record<string, unknown>);
  const memory = isObject(data.memory) ? data.memory : undefined;
  const loop = isObject(data.loop) ? data.loop : {};
  const engine = isObject(data.engine) ? data.engine : {};
  if (engine.instructions !== undefined)
    return { ok: false, reason: "engine.instructions replaces the engine's wording, which agent-folder/3 doesn't do: the plugins' words are the Runtime's. Remove it first" };
  if (memory && memory.access === "read_only" && input.role === "root")
    return { ok: false, reason: "memory.access: read_only for the root agent has no plugin form: in agent-folder/3 the root agent may write its memory" };
  if (memory && memory.index === false) return { ok: false, reason: "memory.index: false has no plugin form: nylorun-memory always pins its index" };

  const plugins: PluginName[] = [];
  const off: string[] = [];
  if (memory && input.role === "root") plugins.push("nylorun-memory");
  if (input.role === "root" && (engine.triggers === true || runtime?.selfWake === true)) plugins.push("nylorun-triggers");
  if (input.role === "root" && loop.plan === true) plugins.push("nylorun-plan");
  if (input.role === "root" && loop.connections === true) {
    plugins.push("nylorun-interactions");
    off.push("ask");
  }
  const artifacts = isObject(engine.artifacts) ? engine.artifacts : {};
  if (artifacts.read === true || artifacts.save === true) {
    plugins.push("nylorun-artifacts");
    if (artifacts.read !== true) off.push("read_artifact");
    if (artifacts.save !== true) off.push("save_artifact");
  }
  const sandbox = Array.isArray(engine.sandbox) ? (engine.sandbox as string[]) : [];
  if (sandbox.length > 0) {
    plugins.push("nylorun-sandbox");
    off.push(...SANDBOX_TOOL_NAMES.filter((tool) => !sandbox.includes(tool)));
  }

  // The frontmatter, edited in place: comments and the other keys stay as they are.
  doc.delete("memory");
  doc.delete("loop");
  const engineNode = doc.get("engine", true);
  if (isMap(engineNode)) {
    for (const key of ["sandbox", "artifacts", "triggers", "instructions"]) engineNode.delete(key);
    if (engineNode.items.length === 0) doc.delete("engine");
  }
  if (input.role === "root") {
    if (doc.has("format")) doc.set("format", AGENT_FOLDER_V3);
    else (doc.contents as YAMLMap).items.unshift(doc.createPair("format", AGENT_FOLDER_V3));
  }
  if (plugins.length > 0) {
    const seq = new YAMLSeq();
    for (const name of plugins) seq.add(doc.createNode(name));
    seq.flow = true;
    doc.set("plugins", seq);
  }
  if (off.length > 0) {
    const known = new Set(plugins.flatMap(pluginTools));
    const tools = Object.fromEntries(off.filter((tool) => known.has(tool)).map((tool) => [tool, { enabled: false }]));
    if (Object.keys(tools).length > 0) {
      const node = doc.createNode({ tools }) as YAMLMap;
      for (const pair of node.items) if (isMap(pair.value)) pair.value.flow = false;
      const servers = doc.get("mcpServers", true);
      if (isMap(servers)) servers.set(RUNTIME_SERVER, node);
      else doc.set("mcpServers", doc.createNode({ [RUNTIME_SERVER]: { tools } }));
    }
  }
  const front = new Document(doc.contents).toString({ lineWidth: 0 }).replace(/\n$/, "");
  const instructions = memory && typeof memory.instructions === "string" && memory.instructions.trim() !== "" ? memory.instructions.trim() : undefined;
  const body = instructions === undefined ? parts.body : `${parts.body.replace(/\s+$/, "")}\n\n${instructions}\n`;
  const agentMd = ["---", front, "---", body].join("\n").replaceAll("\n", parts.eol);
  let runtimeJson = input.runtimeJson;
  if (runtime && runtime.selfWake !== undefined) {
    const { selfWake: _wake, ...rest } = runtime;
    runtimeJson = `${JSON.stringify(rest, null, 2)}\n`;
  }
  return { ok: true, agentMd, ...(runtimeJson === undefined ? {} : { runtimeJson }), plugins };
}
