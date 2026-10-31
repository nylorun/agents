/**
 * The folders inside an agent folder (track T7, D80; design §3.3, §3.8), compiled by the same
 * compiler, one level in:
 *
 * - **Subagents.** `agents/<id>/` of an agent (no `flow.json` beside it) is an agent folder
 *   without `runtime.json`, `triggers/` or `files/`, offered to the agent as a tool, exactly as
 *   the TypeScript builder offers an agent used as a tool: named `<id>`, with the agent's
 *   description, input `{ task }`, and the agent's manifest embedded. One level deep: a subagent
 *   has no `agents/` of its own, unless it is a flow (a flow offered as a tool).
 * - **Flows.** `flow.json` makes a folder a flow (`harness.kind: "workflow"`, v3's node tree).
 *   A flow root has one flat `agents/`, and every `flow.json` under it names stages from there by
 *   id. A stage with its own `flow.json` is a sub-flow over the same agents, so it has no
 *   `agents/`. The compiler embeds each agent where v3 wants it. A flow's `AGENT.md` has no body
 *   and may name `inputSchema`; a flow has no `mcp.json`, `skills/` or plugins, and only the
 *   tools its nodes name. An agent of `agents/` that no `flow.json` names is a warning.
 * - **Plugins.** `plugins/<name>/` (`plugins.ts`).
 *
 * A folder inside another reports its diagnostics with paths from the uploaded folder
 * (`agents/research/flow.json:3:12`). `/x` in it names a file from the uploaded folder's root,
 * and `./x` one from its own. A slot it needs is derived in the uploaded folder's runtime
 * section.
 */
import { DELEGATE_INPUT_SCHEMA, DELEGATE_NAME_PATTERN } from "../definition/delegate.js";
import { loopManifestOf } from "../definition/sections.js";
import { TOOL_SECRET_NAME_PATTERN, type AgentManifestV8 } from "../contracts.js";
import type { AgentFolderEntry } from "./compile.js";
import {
  addInner,
  cloneJson,
  foldersUnder,
  isObject,
  jsonPosition,
  type EmbeddedAgent,
  type FlowNamespaceLike,
  type FolderContext,
  type FolderScope,
  type SchemaLookup,
} from "./context.js";
import { translateFlow } from "./flow.js";
import { foldPlugins, pluginTextPaths, type FoldedPlugins } from "./plugins.js";

export type { FolderScope } from "./context.js";

const AGENT_FILE = "AGENT.md";
const FLOW_FILE = "flow.json";

/** The files of every folder under `agents/` and `plugins/` the compiler reads. */
export function nestedTextPaths(entries: readonly AgentFolderEntry[], folderTextPaths: (entries: readonly AgentFolderEntry[]) => string[]): string[] {
  const paths: string[] = [];
  const all = entries.map((entry) => entry.path);
  for (const id of foldersUnder("agents", all).keys()) {
    const prefix = `agents/${id}/`;
    const nested = entries.filter((entry) => entry.path.startsWith(prefix)).map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    paths.push(...folderTextPaths(nested).map((path) => prefix + path));
  }
  for (const [name, inner] of foldersUnder("plugins", all)) paths.push(...pluginTextPaths(inner).map((path) => `plugins/${name}/${path}`));
  return paths;
}

/** `/x` from a folder inside another: the uploaded folder's file, or why not. */
export function scopedSchema(scope: FolderScope, value: string, fail: (code: string, message: string) => void): Record<string, unknown> | undefined {
  const found = scope.schema(value.slice(1));
  if (found === undefined) return undefined;
  if ("message" in found) {
    fail(found.code, found.message);
    return undefined;
  }
  return found.schema;
}

/** The hooks `compileAgentFolder` calls for one folder: plugins, subagents and flows. */
export function folderParts(ctx: FolderContext) {
  const isFlow = [...ctx.kinds.values()].includes("flow");
  let plugins: FoldedPlugins | undefined;
  const folded = () => (plugins ??= isFlow ? { servers: new Map(), skills: new Map() } : foldPlugins(ctx));
  return {
    /** Adds the plugins' MCP servers, before `AGENT.md` says how the agent uses them. */
    mergeServers(servers: Record<string, Record<string, unknown>>): void {
      for (const [key, { server, file }] of folded().servers) {
        if (servers[key]) {
          ctx.report("error", "plugin_duplicate", `MCP server ${key} is declared in mcp.json and by this plugin: an agent has one server of a name`, file, ["mcpServers", key], {
            at: jsonPosition(ctx, file, ["mcpServers", key], true),
          });
          continue;
        }
        servers[key] = server;
        ctx.origins.push([["harness", "mcpServers", key], { file, path: ["mcpServers", key] }]);
      }
    },
    /**
     * `credential` in `AGENT.md`'s block for a plugin's server, which cannot know the agent's slot
     * names. True when the server is a plugin's, so the block may name it.
     */
    serverCredential(servers: Record<string, Record<string, unknown>>, key: string, settings: Record<string, unknown>, at: readonly PropertyKey[]): boolean {
      const server = servers[key];
      if (!server || server.plugin === undefined) return false;
      const credential = settings.credential;
      if (credential === undefined) return true;
      const path = [...at, "credential"];
      if (typeof credential !== "string" || !TOOL_SECRET_NAME_PATTERN.test(credential)) {
        ctx.report("error", "credential_name", "credential names a secret slot: 1-64 letters, digits, '.', '_' and '-'", AGENT_FILE, path);
        return true;
      }
      if (server.credential !== undefined) {
        ctx.report("error", "credential_twice", `The plugin's mcp.json already names ${String(server.credential)} for ${key}: a server authenticates with one credential`, AGENT_FILE, path);
        return true;
      }
      server.credential = credential;
      ctx.deriveSlot(credential, "bearer", String(server.url), AGENT_FILE, path);
      ctx.origins.push([["harness", "mcpServers", key, "credential"], { file: AGENT_FILE, path }]);
      return true;
    },
    /** Adds the plugins' skills, before `AGENT.md` says which secrets each gets. */
    mergeSkills(skills: Record<string, Record<string, unknown>>): void {
      for (const [key, { skill, file }] of folded().skills) {
        if (skills[key]) {
          ctx.report("error", "plugin_duplicate", `Skill ${key} is in skills/ and in this plugin: an agent has one skill of a name`, file);
          continue;
        }
        skills[key] = skill;
        ctx.origins.push([["harness", "skills", key], { file, path: [] }]);
      }
    },
    /**
     * Subagents, or the flow: called once the folder's own parts are compiled. False when a part
     * it needs did not compile and its errors are reported elsewhere (a stage of the flow root).
     */
    compose(): boolean {
      if (ctx.scope && ctx.scope.role !== "plugin") nestedChecks(ctx);
      if (isFlow) return composeFlow(ctx);
      composeAgent(ctx);
      return true;
    },
  };
}

/** The scope of a folder inside this one: its slots and `/x` schemas are the uploaded folder's. */
function innerScope(ctx: FolderContext, prefix: string, role: FolderScope["role"], namespace?: FlowNamespaceLike): FolderScope {
  return {
    role,
    ...(namespace === undefined ? {} : { namespace }),
    deriveSlot: (credential, type, url, file, at, header) => ctx.deriveSlot(credential, type, url, prefix + file, [], header, at),
    schema: ctx.scope?.schema ?? rootSchema(ctx),
  };
}

/** `/x` read from the uploaded folder: a JSON Schema file anywhere in it. */
function rootSchema(ctx: FolderContext): (target: string) => SchemaLookup {
  const read = new Map<string, Record<string, unknown> | undefined>();
  return (target) => {
    if (target.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
      return { code: "path_outside", message: `/${target} leaves the folder: a path names a file inside it` };
    if (!ctx.entries.has(target)) return { code: "schema_missing", message: `/${target} is not a file in the folder` };
    const kind = ctx.kinds.get(target);
    const segments = target.split("/");
    const base = segments.at(-1)!;
    const schemaFile = kind === "schema" || (kind === "nested" && (base.endsWith(".schema.json") || (segments.includes("schemas") && base.endsWith(".json"))));
    if (!schemaFile) return { code: "schema_invalid", message: `/${target} is not a JSON Schema file: name it *.schema.json or keep it under schemas/` };
    if (!read.has(target)) read.set(target, ctx.readJson(target));
    const schema = read.get(target);
    return schema === undefined ? undefined : { schema };
  };
}

/** Compiles `prefix` (`agents/<id>/`) as a folder of its own, its diagnostics added to this one's. */
function compileInner(ctx: FolderContext, prefix: string, role: FolderScope["role"], namespace?: FlowNamespaceLike): AgentManifestV8 | undefined {
  const entries: AgentFolderEntry[] = [];
  for (const [path, entry] of ctx.entries) if (path.startsWith(prefix)) entries.push({ ...entry, path: path.slice(prefix.length) });
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of ctx.files) if (path.startsWith(prefix)) files.set(path.slice(prefix.length), bytes);
  const name = prefix.split("/").at(-2)!;
  const result = ctx.compile({ entries, files, name }, innerScope(ctx, prefix, role, namespace));
  addInner(ctx, prefix, result.diagnostics);
  return result.manifest;
}

/** Why an id under `agents/` cannot name a tool or a stage, or undefined when it can. */
function badId(ctx: FolderContext, id: string): boolean {
  if (DELEGATE_NAME_PATTERN.test(id)) return false;
  ctx.report(
    "error",
    "agent_name",
    `agents/${id}/ names a tool or a stage, so its name takes only letters, digits, _ and -, up to 64 characters`,
    `agents/${id}/${AGENT_FILE}`,
  );
  return true;
}

/** The first file of `agents/<id>/`, for a diagnostic about the folder. */
const folderFile = (id: string, inner: readonly string[]) => `agents/${id}/${inner.includes(AGENT_FILE) ? AGENT_FILE : inner[0]!}`;

/** What only the uploaded folder has: a subagent or stage runs in its runtime and its harness. */
function nestedChecks(ctx: FolderContext): void {
  const what = ctx.scope!.role === "subagent" ? "a subagent" : "a stage of a flow";
  const refuse = (message: string, file: string, path?: readonly PropertyKey[]) =>
    ctx.report("error", "nested_refused", message, file, path, { key: path !== undefined && path.length > 0 });
  for (const [path, kind] of ctx.kinds) {
    if (kind === "runtime") refuse(`runtime.json is the uploaded folder's: ${what} runs in its runtime, so move this to the root`, path);
    else if (kind === "trigger") refuse(`triggers/ is the uploaded folder's: a trigger starts the root agent, so move this to the root's triggers/`, path);
    else if (kind === "file") refuse(`files/ is the uploaded folder's: its runtime seeds the disk every agent shares, so move this to the root's files/`, path);
  }
  const keys: Record<string, string> = {
    format: "format is read only in the uploaded folder's AGENT.md: one folder, one format",
    harness: `${what} runs in the harness of the agent that holds it: set harness in the root's AGENT.md`,
    memory: `memory is the root agent's: ${what} keeps none of its own`,
    loop: `loop settings are the root agent's: ${what} has none of its own`,
    model: `model is the root agent's: ${what} runs in the root agent's session, on its model`,
  };
  for (const [key, message] of Object.entries(keys)) if (ctx.front[key] !== undefined) refuse(message, AGENT_FILE, [key]);
  // Agent manifest v7, which embeds an agent, has no place for a credential or a skill's secrets.
  const settings = isObject(ctx.front.mcpServers) ? ctx.front.mcpServers : {};
  for (const [key, server] of Object.entries(isObject(ctx.harness.mcpServers) ? ctx.harness.mcpServers : {})) {
    if (!isObject(server) || server.credential === undefined) continue;
    const message = `${key} authenticates with ${String(server.credential)}, and ${what}'s MCP servers take no credential: only the root agent's servers do. Give the server to the root agent, or call it without one`;
    if (isObject(settings[key]) && settings[key].credential !== undefined) ctx.report("error", "credential_unsupported", message, AGENT_FILE, ["mcpServers", key, "credential"]);
    else if (server.plugin !== undefined) {
      const origin = ctx.origins.find(([path]) => path.length === 3 && path[1] === "mcpServers" && path[2] === key)?.[1];
      ctx.report("error", "credential_unsupported", message, origin?.file, origin?.path, { at: origin && jsonPosition(ctx, origin.file, origin.path, true) });
    }
    else ctx.report("error", "credential_unsupported", message, "mcp.json", ["mcpServers", key, "headers"]);
  }
  for (const [key, skill] of Object.entries(isObject(ctx.harness.skills) ? ctx.harness.skills : {}))
    if (isObject(skill) && skill.secrets !== undefined)
      ctx.report("error", "credential_unsupported", `Only the root agent's skills get secrets: ${what}'s skill ${key} gets none`, AGENT_FILE, ["skills", key, "secrets"]);
}

/** An agent: its `agents/` are tools, and its plugins are listed. */
function composeAgent(ctx: FolderContext): void {
  if (ctx.front.inputSchema !== undefined)
    ctx.report(
      "error",
      "input_schema_refused",
      "inputSchema is a flow's: an agent's input is the message, and a subagent's is { task }. A folder is a flow when it has a flow.json",
      AGENT_FILE,
      ["inputSchema"],
      { key: true },
    );
  const harness = ctx.harness;
  const folders = foldersUnder("agents", ctx.entries.keys());
  if (folders.size > 0 && ctx.scope?.role === "subagent")
    for (const [id, inner] of folders)
      ctx.report(
        "error",
        "subagent_depth",
        `A subagent has no subagents: agents used as tools nest one level deep. Move agents/${id}/ to the agent that uses it`,
        folderFile(id, inner),
      );
  else if (folders.size > 0) {
    const tools = Array.isArray(harness.tools) ? (harness.tools as Record<string, unknown>[]) : [];
    const httpTools = new Set(tools.map((tool) => tool.name));
    for (const [id, inner] of folders) {
      if (badId(ctx, id)) continue;
      if (httpTools.has(id)) {
        ctx.report("error", "tool_twice", `agents/${id}/ and tools/${id}.json both name the tool ${id}: rename one`, folderFile(id, inner));
        continue;
      }
      const manifest = compileInner(ctx, `agents/${id}/`, "subagent");
      if (!manifest) continue;
      ctx.origins.push([["harness", "tools", tools.length], { file: `agents/${id}/${AGENT_FILE}`, path: [] }]);
      // As the TypeScript builder emits an agent used as a tool (`delegateTool`).
      tools.push({
        name: id,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        inputSchema: cloneJson(DELEGATE_INPUT_SCHEMA),
        agent: loopManifestOf(manifest),
      });
    }
    if (tools.length > 0) harness.tools = tools;
  }
  // The plugins its skills and servers came from, each once, by name (`pluginsOf`).
  const labels = new Map<string, { name: string; version?: string }>();
  for (const item of [...Object.values(isObject(harness.skills) ? harness.skills : {}), ...Object.values(isObject(harness.mcpServers) ? harness.mcpServers : {})]) {
    const label = isObject(item) && isObject(item.plugin) ? (item.plugin as { name: string; version?: string }) : undefined;
    if (label && !labels.has(label.name)) labels.set(label.name, { ...label });
  }
  if (labels.size > 0) harness.plugins = [...labels.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A flow root's `agents/`: compiled once each, when a node first names it. */
class FlowNamespace implements FlowNamespaceLike {
  readonly ids: readonly string[];
  readonly used = new Set<string>();
  readonly #members = new Map<string, "compiling" | { manifest?: EmbeddedAgent }>();
  readonly #ctx: FolderContext;

  constructor(ctx: FolderContext, folders: ReadonlyMap<string, readonly string[]>) {
    this.#ctx = ctx;
    this.ids = [...folders.keys()];
    for (const id of this.ids) if (badId(ctx, id)) this.#members.set(id, {});
  }

  resolve(id: string): EmbeddedAgent | "unknown" | "cycle" | "failed" {
    if (!this.ids.includes(id)) return "unknown";
    const member = this.#members.get(id);
    if (member === "compiling") return "cycle";
    if (member) return member.manifest ?? "failed";
    this.#members.set(id, "compiling");
    const manifest = compileInner(this.#ctx, `agents/${id}/`, "stage", this);
    const embedded = manifest === undefined ? undefined : (loopManifestOf(manifest) as unknown as EmbeddedAgent);
    this.#members.set(id, embedded === undefined ? {} : { manifest: embedded });
    return embedded ?? "failed";
  }
}

/** A flow: `flow.json`'s node tree over the flow root's agents and the tools beside it. */
function composeFlow(ctx: FolderContext): boolean {
  const { harness, front } = ctx;
  const refuse = (message: string, file: string, path?: readonly PropertyKey[]) =>
    ctx.report("error", "flow_refused", message, file, path, { key: path !== undefined && path.length > 0 });
  // What a flow has none of: each of its agents has its own.
  if (ctx.agent) {
    const lines = ctx.agent.body.split("\n");
    const first = lines.findIndex((line) => line.trim() !== "");
    if (first >= 0)
      ctx.report("error", "flow_body", "A flow's AGENT.md has no body: a flow has no instructions, and each of its agents has its own", AGENT_FILE, undefined, {
        at: { line: ctx.agent.bodyLine + first, column: 1 },
      });
  }
  const noted = new Set<string>();
  for (const [path, kind] of ctx.kinds) {
    const top = path.split("/").slice(0, 2).join("/");
    if (kind === "instructions") refuse("A flow has no instructions: move this to the agent under agents/ that needs it", path);
    else if (kind === "mcp") refuse("A flow has no MCP servers of its own: give mcp.json to the agents under agents/ that call them", path);
    else if ((kind === "skill" || kind === "plugin") && !noted.has(top)) {
      noted.add(top);
      refuse(
        kind === "skill" ? `A flow has no skills of its own: move ${top}/ to the agent that uses it` : `A flow takes no plugins: vendor ${top}/ in the agent that uses it`,
        `${top}/`,
      );
    }
  }
  for (const key of ["mcpServers", "skills", "memory", "model"])
    if (front[key] !== undefined) refuse(`${key} is an agent's: set it in the AGENT.md of the agent under agents/ that needs it`, AGENT_FILE, [key]);
  const inputSchema = front.inputSchema === undefined ? undefined : ctx.schemaAt(AGENT_FILE, ["inputSchema"], front.inputSchema);

  // The agents it names: the flow root's.
  const own = foldersUnder("agents", ctx.entries.keys());
  let namespace: FlowNamespaceLike;
  let isRoot = false;
  if (ctx.scope?.role === "stage" && ctx.scope.namespace) {
    namespace = ctx.scope.namespace;
    for (const [id, inner] of own)
      ctx.report(
        "error",
        "flow_namespace",
        `A sub-flow names its stages from the flow root's agents/, so it has none of its own: move agents/${id}/ to the flow root's agents/`,
        folderFile(id, inner),
      );
  } else {
    namespace = new FlowNamespace(ctx, own);
    isRoot = true;
  }

  const flow = ctx.readJson(FLOW_FILE);
  if (!flow) {
    // Its agents are compiled all the same, so one pass finds their errors too.
    if (isRoot) for (const id of namespace.ids) namespace.resolve(id);
    return true;
  }
  if ("$schema" in flow) ctx.checkSchemaUrl(FLOW_FILE, "flow", flow.$schema);
  const { $schema: _, ...tree } = flow;
  const tools = new Map<string, Record<string, unknown>>();
  for (const tool of Array.isArray(harness.tools) ? (harness.tools as Record<string, unknown>[]) : []) tools.set(String(tool.name), tool);
  const translated = translateFlow(
    tree,
    { agentIds: namespace.ids, agent: (id) => namespace.resolve(id), used: namespace.used, tools },
    (code, message, file, path, options) => ctx.report("error", code, message, file, path, options),
    ctx.suggest,
  );
  for (const name of tools.keys())
    if (!translated.toolsUsed.has(name))
      ctx.report("error", "tool_unused", `No node of flow.json names ${name}: a flow holds only the tools its nodes name`, `tools/${name}.json`);
  if (isRoot) {
    const unused = namespace.ids.filter((id) => !namespace.used.has(id));
    for (const id of unused) {
      // Compiled all the same, so its errors are found now rather than when it is named.
      namespace.resolve(id);
      ctx.report(
        "warning",
        "agent_unused",
        `No flow.json under the flow root names ${id}, so it never runs and is left out of the manifest: name it in a node, or remove it`,
        folderFile(id, own.get(id)!),
      );
    }
  }
  if (!translated.complete) return false;
  if (!translated.root) return true;

  // The workflow harness, in place of the agent harness built so far.
  const { id, outputSchema, loop } = harness;
  for (const key of Object.keys(harness)) delete harness[key];
  Object.assign(harness, {
    kind: "workflow",
    ...(id === undefined ? {} : { id }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    root: translated.root,
    agents: translated.agents,
    ...(loop === undefined ? {} : { loop }),
  });
  ctx.origins.push([["harness", "root"], { file: FLOW_FILE, path: [] }], [["harness", "inputSchema"], { file: AGENT_FILE, path: ["inputSchema"] }]);
  for (const agent of Object.keys(translated.agents))
    ctx.origins.push([["harness", "agents", agent], { file: isRoot ? `agents/${agent}/${AGENT_FILE}` : FLOW_FILE, path: [] }]);
  return true;
}
