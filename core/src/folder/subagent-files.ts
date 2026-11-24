/**
 * `agent-folder/4`: a subagent is one file, `agents/<id>.md`, and the manifest's
 * `tools/`, `skills/`, `mcp.json`, `plugins/` and Runtime plugins are its **library**, which every
 * model loop in it draws on: the root's own, and each subagent's, which inherits it and narrows it
 * with `tools`, `disallowedTools`, `skills` and `mcpServers`.
 *
 * ```markdown
 * ---
 * name: history
 * description: Searches the person's past work.
 * tools: [search_work, get_task]
 * ---
 * You find earlier work for a bot…
 * ```
 *
 * A subagent is named by its frontmatter `name`, whatever its file is called, as Claude Code and
 * Cursor name theirs. An Agent Plugin's `agents/*.md` under `plugins/<name>/` are subagents too, read
 * by the same rules and labelled with the plugin; no subagent inherits another.
 *
 * The compiler keeps every check it has by **expanding** format 4 into the layout format 3 already
 * compiles: each subagent file becomes a virtual `agents/<name>/` holding the file's bytes as its
 * `AGENT.md` and a copy of the library (the same bytes and hashes), or, for a file with `flow:`,
 * its flow file and the library tools the flow names. The subagent's compile then narrows what it
 * inherited (`narrowFront`, `narrowParts`), and every diagnostic is moved back to the file people
 * wrote (`compileFormat4`). Pure, like the compiler.
 */
import type { AgentFolderDiagnostic, AgentFolderEntry, CompileAgentFolderInput, CompiledAgentFolder } from "./compile.js";
import { parseMarkdown } from "./frontmatter.js";
import { PLUGIN_NAMES, pluginOfTool, pluginTools, RUNTIME_SERVER, type PluginName } from "../plugins/index.js";
import { suggestion } from "./suggest.js";
import type { ReportOptions } from "./context.js";
import { pluginLabelOf, pluginSubagentFile, pluginSubagentFlow, type PluginLabel } from "./plugins.js";

/** The format name a v4 folder writes. */
export const AGENT_FOLDER_V4 = "agent-folder/4";

/** Whether `value` names the v4 format: `agent-folder/4` or `4`. */
export function isFolderV4(value: unknown): boolean {
  return value === 4 || value === AGENT_FOLDER_V4;
}

/** The keys a subagent file adds to `AGENT.md`'s, and the root's in format 4. */
export const SUBAGENT_FILE_KEYS = ["tools", "disallowedTools", "flow", "readonly"] as const;
/** The root's own narrowing keys in format 4. */
export const ROOT_V4_KEYS = ["tools", "disallowedTools"] as const;
/**
 * Keys Claude Code and Cursor write that mean nothing here: noted and ignored, so their files drop
 * in. `memory` is one only as a string (Claude Code's `user`, `project` or `local`).
 */
export const HOST_KEYS = [
  "model",
  "color",
  "permissionMode",
  "hooks",
  "maxTurns",
  "background",
  "isolation",
  "effort",
  "initialPrompt",
  "omitClaudeMd",
  "autoCompactWindow",
  "experimental",
  "is_background",
  "license",
] as const;
/** Claude Code's tool names that are ours under another spelling. */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, string>> = { Read: "read", Grep: "grep", Glob: "glob", Write: "write", Edit: "edit", Bash: "bash" };
/** Claude Code's other tool names: noted and ignored. */
const CLAUDE_TOOLS = ["WebFetch", "WebSearch", "Agent", "Task", "Skill", "TodoWrite", "NotebookEdit", "NotebookRead", "MultiEdit", "LS", "BashOutput", "KillShell", "KillBash", "ExitPlanMode", "SlashCommand", "ListMcpResourcesTool", "ReadMcpResourceTool"];
/** The Runtime plugins only the root agent uses: a subagent never inherits them, and names their tools only with an error. */
export const ROOT_ONLY_PLUGINS: readonly PluginName[] = ["nylorun-triggers", "nylorun-plan", "nylorun-interactions"];
/** The Runtime plugin a subagent inherits only when it names its tool. */
const NAMED_ONLY_PLUGINS: readonly PluginName[] = ["nylorun-memory"];
const READONLY_TOOLS = ["read", "grep", "glob"];

const AGENT_FILE = "AGENT.md";
const FLOW_FILE = "flow.json";
const decoder = new TextDecoder("utf-8", { fatal: true });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function textOf(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    return decoder.decode(bytes).replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

function frontOf(bytes: Uint8Array | undefined): Record<string, unknown> | undefined {
  const text = textOf(bytes);
  if (text === undefined) return undefined;
  const result = parseMarkdown(text);
  return result.ok ? result.data : undefined;
}

function jsonOf(bytes: Uint8Array | undefined): unknown {
  const text = textOf(bytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether the uploaded folder's `AGENT.md` names format 4, read quietly. */
export function folderIsV4(input: CompileAgentFolderInput): boolean {
  return isFolderV4(frontOf(input.files.get(AGENT_FILE))?.format);
}

/** A subagent file's id from its path, or undefined: `agents/<id>.md`. */
export function subagentFileId(path: string): string | undefined {
  const match = /^agents\/([^/]+)\.md$/.exec(path);
  return match?.[1];
}

/** The path `flow:` names, from a subagent file in `dir`: `./x` and `x` from `dir`, `/x` from the root. */
export function flowPathOf(value: unknown, dir = "agents"): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const target = value.startsWith("/") ? value.slice(1) : `${dir}/${value.replace(/^\.\//, "")}`;
  return target.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? undefined : target;
}

/** The ids a flow's nodes name as `agent` and the names they name as `tool`. */
function flowNames(tree: unknown): { agents: Set<string>; tools: Set<string> } {
  const agents = new Set<string>();
  const tools = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isObject(value)) {
      if (typeof value.agent === "string") agents.add(value.agent);
      if (typeof value.tool === "string") tools.add(value.tool);
      Object.values(value).forEach(walk);
    }
  };
  walk(tree);
  return { agents, tools };
}

/**
 * A plugin's subagent folder: `plugins/<name>/agents/`, with what it holds. Its files stay in the
 * library as the plugin's files (mounted with the plugin), but a subagent's compile never reads them
 * as subagents: no subagent inherits another.
 */
const PLUGIN_AGENTS = /^plugins\/([^/]+)\/agents\/(.+)$/;
const isLibrary = (path: string) => path === "mcp.json" || /^(tools|skills|plugins)\//.test(path);
/** A name a subagent can go by: the tool the model calls. */
const SUBAGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** One subagent file: the name it compiles to, where it was written, and the plugin it came from. */
interface SubagentSource {
  readonly name: string;
  readonly path: string;
  readonly plugin?: PluginLabel;
}

/**
 * Compiles a format 4 folder: expands its subagent files, compiles the result as `compile` does a
 * format 3 folder, and moves each diagnostic back to the file people wrote.
 */
export function compileFormat4(input: CompileAgentFolderInput, compile: (input: CompileAgentFolderInput) => CompiledAgentFolder): CompiledAgentFolder {
  const byPath = new Map(input.entries.map((entry) => [entry.path, entry]));
  const library = input.entries.filter((entry) => isLibrary(entry.path));
  const flowRoot = byPath.has(FLOW_FILE);
  const entries: AgentFolderEntry[] = [];
  const files = new Map<string, Uint8Array>(input.files);
  const extra: AgentFolderDiagnostic[] = [];
  /** Where each subagent's flow file is, by name. */
  const flows = new Map<string, string>();

  // Every subagent file, the folder's own and its plugins', by the name it goes by.
  const sources = new Map<string, SubagentSource>();
  const fronts = new Map<string, Record<string, unknown>>();
  const labels = new Map<string, PluginLabel>();
  const nameOf = (front: Record<string, unknown>, fallback: string) => (typeof front.name === "string" && SUBAGENT_NAME.test(front.name) ? front.name : fallback);
  const take = (source: SubagentSource, front: Record<string, unknown>) => {
    const other = sources.get(source.name);
    const tool = byPath.has(`tools/${source.name}.json`) ? `tools/${source.name}.json` : undefined;
    if (other || (tool && source.plugin)) {
      const where = other?.path ?? tool!;
      extra.push(
        source.plugin || other?.plugin
          ? { severity: "error", code: "plugin_duplicate", message: `${source.name} is also ${where}: an agent has one subagent or tool of a name`, file: source.path }
          : { severity: "error", code: "tool_twice", message: `${other!.path} and ${source.path} both name the subagent ${source.name}: rename one`, file: source.path },
      );
      return;
    }
    sources.set(source.name, source);
    fronts.set(source.name, front);
    if (source.plugin) labels.set(source.name, source.plugin);
  };
  for (const entry of [...input.entries].sort((a, b) => compare(a.path, b.path))) {
    const id = subagentFileId(entry.path);
    if (id === undefined) continue;
    const front = frontOf(input.files.get(entry.path)) ?? {};
    take({ name: nameOf(front, id), path: entry.path }, front);
  }
  const pluginLabels = new Map<string, PluginLabel | undefined>();
  for (const entry of [...input.entries].sort((a, b) => compare(a.path, b.path))) {
    const match = PLUGIN_AGENTS.exec(entry.path);
    if (!match) continue;
    const [, plugin, rest] = match as unknown as [string, string, string];
    const file = pluginSubagentFile(`agents/${rest}`);
    // A flow file a subagent's `flow:` names is read from where it is when it is named.
    if (file === undefined && pluginSubagentFlow(`agents/${rest}`)) continue;
    if (file === undefined) {
      extra.push({ severity: "note", code: "plugin_part_ignored", message: "Kept with the source: a plugin's subagents are its agents/*.md files", file: entry.path });
      continue;
    }
    if (!pluginLabels.has(plugin)) pluginLabels.set(plugin, pluginLabelOf(jsonOf(input.files.get(`plugins/${plugin}/plugin.json`))));
    // A plugin whose plugin.json names it nothing is refused by the plugin's own checks.
    const label = pluginLabels.get(plugin);
    if (!label) continue;
    const front = frontOf(input.files.get(entry.path)) ?? {};
    take({ name: nameOf(front, file), path: entry.path, plugin: label }, front);
  }
  const names = [...sources.keys()].sort(compare);

  // A folder under agents/ is format 3's: refused, and left out of the expansion. A plugin's
  // subagent files are read above as subagents, and stay in the entries as the plugin's files.
  const folders = new Set<string>();
  for (const entry of input.entries) {
    const segments = entry.path.split("/");
    if (segments[0] === "agents" && segments.length >= 3) {
      if (!folders.has(segments[1]!))
        extra.push({
          severity: "error",
          code: "subagent_folder",
          message: `agents/${segments[1]}/ is a subagent folder, which agent-folder/4 writes as one file, agents/${segments[1]}.md, drawing on the manifest's tools/, skills/ and mcp.json. Fix: run nylorun migrate folder <dir> --to 4`,
          file: `agents/${segments[1]}/${byPath.has(`agents/${segments[1]}/AGENT.md`) ? AGENT_FILE : segments.slice(2).join("/")}`,
        });
      folders.add(segments[1]!);
      continue;
    }
    entries.push(entry);
  }

  const add = (path: string, source: AgentFolderEntry) => {
    if (entries.some((entry) => entry.path === path)) return;
    entries.push({ path, size: source.size, sha256: source.sha256 });
    const bytes = input.files.get(source.path);
    if (bytes) files.set(path, bytes);
  };
  /** Expands one subagent file at `prefix` (`agents/<name>/`); `namespace` is a flow subagent's own agents/ under a root driven by a model loop. */
  const expand = (prefix: string, name: string, namespace: string | undefined) => {
    const written = sources.get(name);
    const source = written && byPath.get(written.path);
    if (!written || !source) return;
    add(`${prefix}${AGENT_FILE}`, source);
    const front = fronts.get(name) ?? {};
    if (front.flow === undefined) {
      for (const entry of library) add(prefix + entry.path, entry);
      return;
    }
    const flowPath = flowPathOf(front.flow, written.path.slice(0, written.path.lastIndexOf("/")));
    const flowEntry = flowPath === undefined ? undefined : byPath.get(flowPath);
    if (!flowEntry || !flowPath) return;
    flows.set(name, flowPath);
    add(`${prefix}${FLOW_FILE}`, flowEntry);
    const names = flowNames(jsonOf(input.files.get(flowPath)));
    for (const tool of names.tools) {
      const entry = byPath.get(`tools/${tool}.json`);
      if (entry) add(`${prefix}tools/${tool}.json`, entry);
    }
    // Its stages: the root's, when the root is a flow; else its own agents/, from the sibling files.
    if (namespace === undefined) return;
    for (const stage of names.agents) if (fronts.has(stage) && !entries.some((entry) => entry.path === `${namespace}${stage}/${AGENT_FILE}`)) expand(`${namespace}${stage}/`, stage, namespace);
  };
  for (const name of names) {
    const front = fronts.get(name) ?? {};
    const prefix = `agents/${name}/`;
    expand(prefix, name, front.flow !== undefined && !flowRoot ? `${prefix}agents/` : undefined);
  }

  const compiled = compile({ ...input, entries, files });
  /** Where a subagent's file was written, by name. */
  const writtenAt = (name: string) => sources.get(name)?.path ?? `agents/${name}.md`;
  /** A path of the expansion, as the folder people wrote names it. */
  const real = (path: string): string => {
    let rest = path;
    let id: string | undefined;
    for (;;) {
      const match = /^agents\/([^/]+)\/(.*)$/.exec(rest);
      if (!match || !fronts.has(match[1]!)) break;
      id = match[1]!;
      rest = match[2]!;
    }
    if (id === undefined) {
      const bare = /^agents\/([^/]+)$/.exec(path)?.[1];
      return bare !== undefined && fronts.has(bare) ? writtenAt(bare) : path;
    }
    if (rest === AGENT_FILE || rest === "") return writtenAt(id);
    if (rest === FLOW_FILE) return flows.get(id) ?? writtenAt(id);
    return rest;
  };
  const seen = new Set<string>();
  const diagnostics: AgentFolderDiagnostic[] = [];
  for (const item of [...extra, ...compiled.diagnostics]) {
    const moved: AgentFolderDiagnostic = {
      ...item,
      ...(item.file === undefined ? {} : { file: real(item.file) }),
      ...(item.fix === undefined ? {} : { fix: { ...item.fix, file: real(item.fix.file) } }),
    };
    const key = JSON.stringify([moved.severity, moved.code, moved.message, moved.file, moved.line, moved.column]);
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(moved);
  }
  const order = { error: 0, warning: 1, info: 2, note: 3 } as const;
  diagnostics.sort(
    (a, b) => order[a.severity] - order[b.severity] || compare(a.file ?? "", b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
  const failed = diagnostics.some((item) => item.severity === "error");
  return { ...(failed || !compiled.manifest ? {} : { manifest: labelled(compiled.manifest, labels) }), diagnostics, compiler: AGENT_FOLDER_V4 };
}

/** The manifest with each plugin subagent's tool labelled with its plugin, as a plugin's skills and servers are. */
function labelled<T extends CompiledAgentFolder["manifest"]>(manifest: T, labels: ReadonlyMap<string, PluginLabel>): T {
  const harness = (manifest as { harness?: { tools?: unknown } } | undefined)?.harness;
  if (labels.size === 0 || !harness || !Array.isArray(harness.tools)) return manifest;
  const tools = (harness.tools as Record<string, unknown>[]).map((tool) => {
    const label = typeof tool.name === "string" && tool.agent !== undefined ? labels.get(tool.name) : undefined;
    return label ? { ...tool, plugin: label } : tool;
  });
  return { ...manifest, harness: { ...harness, tools } } as T;
}

/** What a subagent file, or a format 4 root, keeps of what it inherits. Undefined: everything. */
export interface Narrowing {
  /** The HTTP tools it keeps, by name; undefined keeps every one. */
  readonly http?: ReadonlySet<string>;
  /** HTTP tools it drops. */
  readonly httpDenied: ReadonlySet<string>;
  /** The skills it keeps; undefined keeps every one it may have. */
  readonly skills?: readonly { readonly name: string; readonly index: number }[];
  /** The servers it keeps: `mcpServers`' keys; undefined keeps every one it may have. */
  readonly servers?: readonly string[];
  /** A subagent file driven by a flow (`flow:`). */
  readonly flow: boolean;
}

/** What `narrowFront` needs to know. */
export interface NarrowOptions {
  readonly role: "root" | "subagent";
  /** The HTTP tools this folder (or the expansion's copy of the library) holds. */
  readonly httpTools: readonly string[];
  /** The Runtime plugins to inherit from: the parent's (a subagent's), or the root's own. */
  readonly plugins: readonly { readonly name: PluginName; readonly tools: readonly string[] }[];
  readonly error: (code: string, message: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;
  readonly note: (code: string, message: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;
}

/** A tool list as written: a YAML list, or a comma-separated string as Claude Code writes it. */
function namesOf(value: unknown): { name: string; index: number }[] | undefined {
  if (typeof value === "string")
    return value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .map((name) => ({ name, index: -1 }));
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map((name, index) => ({ name: name.trim(), index }));
  return undefined;
}

/**
 * Reads and strips the format 4 keys of `front` (a subagent file's, or a v4 root's), noting other
 * hosts' keys, and writes the Runtime `plugins:` and `mcpServers.nylorun` its tools leave on, so the
 * format 3 compiler that follows sees a folder it knows. Returns what it keeps of the rest.
 */
export function narrowFront(front: Record<string, unknown>, options: NarrowOptions): Narrowing {
  const { role, error, note } = options;
  const subagent = role === "subagent";
  if (subagent) {
    for (const key of HOST_KEYS)
      if (front[key] !== undefined) {
        note("host_key", `${key} is a key other hosts write (Claude Code, Cursor), with no meaning here: ignored`, [key], { key: true });
        delete front[key];
      }
    if (typeof front.memory === "string") {
      note("host_key", "memory as a string is Claude Code's memory directory, with no meaning here: ignored. A subagent may view the Agent's memories when the root has them", ["memory"], { key: true });
      delete front.memory;
    }
  }
  const flow = subagent && front.flow !== undefined;
  if (flow && typeof front.flow !== "string") error("value_invalid", "flow is the path of the subagent's flow file, such as ./research.flow.json", ["flow"]);
  if (flow)
    for (const key of ["tools", "disallowedTools", "skills", "mcpServers", "readonly", "plugins"])
      if (front[key] !== undefined) error("flow_refused", `${key} belongs to a model loop: a subagent driven by a flow has none of its own, and its stages each have theirs`, [key], { key: true });
  delete front.flow;
  if (flow) {
    for (const key of ["tools", "disallowedTools", "skills", "mcpServers", "readonly", "plugins"]) delete front[key];
    return { httpDenied: new Set(), flow: true };
  }

  // The servers it names, before the Runtime's own (`nylorun`) is touched below: its allowlist.
  const servers = subagent && isObject(front.mcpServers) ? Object.keys(front.mcpServers).filter((key) => key !== RUNTIME_SERVER) : undefined;
  // tools and disallowedTools: HTTP tools and the Runtime plugins' tools, by name.
  const known = [...new Set([...options.httpTools, ...options.plugins.flatMap((plugin) => plugin.tools)])];
  const read = (key: "tools" | "disallowedTools"): string[] | undefined => {
    const value = front[key];
    delete front[key];
    if (value === undefined) return undefined;
    const names = namesOf(value);
    if (!names) {
      error("value_invalid", `${key} is a list of tool names, such as [read, grep, glob]`, [key]);
      return [];
    }
    const kept: string[] = [];
    for (const { name, index } of names) {
      const at = index < 0 ? [key] : [key, index];
      const alias = CLAUDE_TOOL_ALIASES[name];
      if (alias !== undefined) {
        note("tool_alias", `${name} is Claude Code's name for ${alias}: read as ${alias}. Fix: write ${alias}`, at);
        if (known.includes(alias)) kept.push(alias);
        else error("library_unknown", `${alias} is not a tool this agent can have: its library holds ${known.join(", ") || "none"}`, at);
        continue;
      }
      if (CLAUDE_TOOLS.includes(name) || name.startsWith("mcp__")) {
        note("host_key", `${name} is Claude Code's tool name, with no meaning here: ignored${name.startsWith("mcp__") ? ". An MCP server's tools are narrowed with mcpServers" : ""}`, at);
        continue;
      }
      if (!known.includes(name)) {
        const close = suggestion(name, known);
        error("library_unknown", `No tool ${name} is in the manifest's library (tools/ and the Runtime plugins it declares).${close ? ` Did you mean '${close}'?` : ""}`, at);
        continue;
      }
      const plugin = pluginOfTool(name);
      if (subagent && plugin && ROOT_ONLY_PLUGINS.includes(plugin)) {
        error("library_unknown", `${name} is the root agent's (${plugin}): a subagent can't pause, set triggers or plan for the whole turn`, at);
        continue;
      }
      kept.push(name);
    }
    return kept;
  };
  let allowed = read("tools");
  const denied = new Set(read("disallowedTools") ?? []);
  if (subagent && front.readonly !== undefined) {
    if (typeof front.readonly !== "boolean") error("value_invalid", "readonly is true or false", ["readonly"]);
    else if (front.readonly && allowed === undefined) {
      note("host_key", "readonly: true is Cursor's: read as tools: [read, grep, glob]", ["readonly"], { key: true });
      allowed = READONLY_TOOLS.filter((tool) => known.includes(tool));
    } else if (front.readonly) note("host_key", "readonly: true is Cursor's, and tools already lists what this subagent gets: ignored", ["readonly"], { key: true });
  }
  delete front.readonly;
  const keep = (tool: string) => (allowed === undefined || allowed.includes(tool)) && !denied.has(tool);

  // The Runtime plugins: a subagent inherits its parent's, but the root's only, and memory only
  // when it names it; the root keeps its own. Either keeps only the tools it allows.
  if (subagent && front.plugins !== undefined) error("value_invalid", "plugins is the root agent's: a subagent file gets the root's Runtime plugins, narrowed with tools", ["plugins"], { key: true });
  const plugins = subagent
    ? options.plugins.filter(
        (plugin) =>
          !ROOT_ONLY_PLUGINS.includes(plugin.name) &&
          (!NAMED_ONLY_PLUGINS.includes(plugin.name) || (allowed !== undefined && plugin.tools.some((tool) => allowed!.includes(tool)))),
      )
    : options.plugins;
  const on = plugins.filter((plugin) => plugin.tools.some(keep));
  if (subagent) {
    if (on.length > 0) front.plugins = on.map((plugin) => plugin.name);
    else delete front.plugins;
  }
  const off = plugins.flatMap((plugin) => plugin.tools.filter((tool) => !keep(tool)));
  if (off.length > 0) {
    const servers = isObject(front.mcpServers) ? front.mcpServers : (front.mcpServers = {});
    const settings = isObject(servers[RUNTIME_SERVER]) ? servers[RUNTIME_SERVER] : (servers[RUNTIME_SERVER] = {});
    const tools = isObject(settings.tools) ? settings.tools : (settings.tools = {});
    for (const tool of off) if (on.some((plugin) => plugin.tools.includes(tool)) || !subagent) tools[tool] = { enabled: false };
    if (Object.keys(tools).length === 0) delete servers[RUNTIME_SERVER];
    if (Object.keys(servers).length === 0) delete front.mcpServers;
  }
  const http = allowed === undefined ? undefined : new Set(allowed.filter((tool) => options.httpTools.includes(tool)));
  const httpDenied = new Set([...denied].filter((tool) => options.httpTools.includes(tool)));

  // skills: a list in a subagent file; the root's stays the map that gives skills secrets.
  let skills: { name: string; index: number }[] | undefined;
  if (subagent && front.skills !== undefined) {
    const names = namesOf(front.skills);
    if (!names) error("value_invalid", "skills in a subagent file lists the library's skills it gets, by name: [checklist]. Only the root agent's skills get secrets", ["skills"]);
    skills = names ?? [];
    delete front.skills;
  }
  return {
    ...(http === undefined ? {} : { http }),
    httpDenied,
    ...(skills === undefined ? {} : { skills }),
    ...(servers === undefined ? {} : { servers }),
    flow: false,
  };
}

/** What a subagent file may not inherit unnamed: the root's skills with secrets and servers with a credential. */
export interface RootSecrets {
  readonly skills: readonly string[];
  readonly servers: readonly string[];
}

/** The root's skills with secrets and plugin servers it gives a credential, read from its frontmatter. */
export function rootSecretsOf(front: Record<string, unknown>): RootSecrets {
  const skills = isObject(front.skills)
    ? Object.entries(front.skills)
        .filter(([, value]) => isObject(value) && Array.isArray(value.secrets) && value.secrets.length > 0)
        .map(([key]) => key)
    : [];
  const servers = isObject(front.mcpServers)
    ? Object.entries(front.mcpServers)
        .filter(([, value]) => isObject(value) && value.credential !== undefined)
        .map(([key]) => key)
    : [];
  return { skills, servers };
}

/**
 * Keeps, of the HTTP tools, skills and servers a subagent file inherited (or a v4 root holds),
 * what its narrowing allows. A subagent also drops the root's skills with secrets and servers with
 * a credential unless it names them, which then fail the checks that follow.
 */
export function narrowParts(
  harness: Record<string, unknown>,
  narrowing: Narrowing,
  options: {
    readonly role: "root" | "subagent";
    readonly secrets: RootSecrets;
    readonly error: (code: string, message: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;
  },
): void {
  if (narrowing.flow) return;
  if (Array.isArray(harness.tools)) {
    const tools = (harness.tools as Record<string, unknown>[]).filter((tool) => {
      const name = String(tool.name);
      if (tool.agent !== undefined) return true;
      return (narrowing.http === undefined || narrowing.http.has(name)) && !narrowing.httpDenied.has(name);
    });
    if (tools.length > 0) harness.tools = tools;
    else delete harness.tools;
  }
  if (options.role !== "subagent") return;
  const skills = isObject(harness.skills) ? harness.skills : {};
  if (narrowing.skills)
    for (const { name, index } of narrowing.skills)
      if (!(name in skills)) {
        const close = suggestion(name, Object.keys(skills));
        options.error("library_unknown", `No skill ${name} is in the manifest's library (skills/ and its plugins).${close ? ` Did you mean '${close}'?` : ""}`, ["skills", index]);
      } else if (options.secrets.skills.includes(name))
        options.error("credential_unsupported", `Only the root agent's skills get secrets: ${name} gets them from the root's AGENT.md, so a subagent can't use it`, ["skills", index]);
  for (const key of Object.keys(skills)) {
    const named = narrowing.skills?.some((item) => item.name === key);
    if ((narrowing.skills !== undefined && !named) || (!named && options.secrets.skills.includes(key))) delete skills[key];
  }
  if (isObject(harness.skills) && Object.keys(skills).length === 0) delete harness.skills;
  const servers = isObject(harness.mcpServers) ? harness.mcpServers : {};
  for (const [key, server] of Object.entries(servers)) {
    const named = narrowing.servers?.includes(key) === true;
    const secret = (isObject(server) && server.credential !== undefined) || options.secrets.servers.includes(key);
    if (named && options.secrets.servers.includes(key))
      options.error("credential_unsupported", `${key} authenticates with a credential the root's AGENT.md gives it, and a subagent's MCP servers take no credential: give the server to the root agent`, ["mcpServers", key]);
    if ((narrowing.servers !== undefined && !named) || (!named && secret)) delete servers[key];
  }
  if (isObject(harness.mcpServers) && Object.keys(servers).length === 0) delete harness.mcpServers;
}

export { PLUGIN_NAMES, pluginTools };
