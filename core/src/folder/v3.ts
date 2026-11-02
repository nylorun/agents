/**
 * `agent-folder/3` (ADR-106): a folder declares the Runtime's features as plugins, by name, and
 * narrows their tools with the settings any MCP server takes:
 *
 * ```yaml
 * format: agent-folder/3
 * plugins: [nylorun-memory, nylorun-triggers, nylorun-plan, nylorun-interactions, nylorun-artifacts, nylorun-sandbox]
 * mcpServers:
 *   nylorun:
 *     tools: { save_artifact: { enabled: false } }
 * engine: { outputs: true, toolSearch: false }     # the harness's own, as in agent-folder/2
 * ```
 *
 * The compiler reads it as the `agent-folder/2` declarations it stands for (`memory`, `loop`,
 * `engine.sandbox`, `engine.artifacts`, `engine.triggers`), so the Runtime checks a v3 agent as it
 * checks a v2 one, and records the plugins in `harness.engine.plugins`, each with the tools left on
 * and the hash of its files. The engine's projection then presents those tools as server
 * `nylorun` (`engineProjection`).
 */
import {
  PLUGIN_NAMES,
  RUNTIME_SERVER,
  isPluginName,
  pluginOf,
  pluginSkills,
  pluginTools,
  type PluginName,
} from "../plugins/index.js";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";
import type { HarnessEnginePlugin } from "../types/manifest.js";
import { suggestion } from "./suggest.js";
import type { ReportOptions } from "./context.js";

/** The format name a v3 folder writes. */
export const AGENT_FOLDER_V3 = "agent-folder/3";
/** The keys of `AGENT.md` a v3 folder declares as plugins instead. */
export const V3_REFUSED_KEYS = ["memory", "loop"] as const;
/** The keys of `engine:` a v3 folder declares as plugins instead. */
export const V3_REFUSED_ENGINE_KEYS = ["sandbox", "artifacts", "triggers", "instructions"] as const;
const MIGRATE = "run nylorun migrate folder <dir> --to 3, which writes the plugins that keep what the agent gets today";

/** Whether `value` names the v3 format: `agent-folder/3` or `3`. */
export function isFolderV3(value: unknown): boolean {
  return value === 3 || value === AGENT_FOLDER_V3;
}

type Fail = (code: string, message: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The plugins a v3 folder declares, each with the tools left on. */
export interface V3Plugins {
  readonly plugins: { readonly name: PluginName; readonly tools: readonly string[] }[];
  /** The frontmatter keys they stand for, in `agent-folder/2`'s terms. */
  readonly memory?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
  readonly engine: Record<string, unknown>;
}

/**
 * Reads a v3 frontmatter's `plugins:` and `mcpServers.nylorun`, refusing the keys it replaces.
 * `parent` is a subagent's parent's plugins: a subagent's are a subset of them. Undefined, with
 * the errors reported, when they are not valid.
 */
export function v3Declarations(
  front: Record<string, unknown>,
  options: {
    readonly error: Fail;
    readonly computer: boolean;
    readonly role: "root" | "subagent";
    readonly parent?: readonly { readonly name: string; readonly tools: readonly string[] }[];
  },
): V3Plugins | undefined {
  const { error, computer, role, parent } = options;
  let valid = true;
  const fail: Fail = (...args) => {
    valid = false;
    error(...args);
  };
  for (const key of V3_REFUSED_KEYS)
    if (front[key] !== undefined)
      fail("v3_refused", `${key} is a key of agent-folder/2: an agent-folder/3 folder declares the Runtime's features as plugins. Fix: ${MIGRATE}`, [key], { key: true });
  if (isObject(front.engine))
    for (const key of V3_REFUSED_ENGINE_KEYS)
      if (front.engine[key] !== undefined)
        fail(
          "v3_refused",
          `engine.${key} is a key of agent-folder/2: in agent-folder/3 the plugins declare it, and engine keeps outputs and toolSearch. Fix: ${MIGRATE}`,
          ["engine", key],
          { key: true },
        );
  const names: PluginName[] = [];
  if (front.plugins !== undefined) {
    if (!Array.isArray(front.plugins)) fail("value_invalid", `plugins is a list of the Runtime's plugins: ${PLUGIN_NAMES.join(", ")}`, ["plugins"]);
    else
      for (const [index, name] of front.plugins.entries()) {
        if (!isPluginName(name)) {
          const close = typeof name === "string" ? suggestion(name, PLUGIN_NAMES) : undefined;
          fail("plugin_unknown", `${JSON.stringify(name)} is not one of the Runtime's plugins: ${PLUGIN_NAMES.join(", ")}.${close ? ` Did you mean '${close}'?` : ""}`, ["plugins", index]);
        } else if (names.includes(name)) fail("value_invalid", `plugins names ${name} twice`, ["plugins", index]);
        else if (pluginOf(name).requires.includes("computer") && !computer)
          fail("plugin_needs_computer", `${name} needs a computer, and the runtime has none. Fix: set "kind": "virtual" (or "pod") in runtime.json, or leave it out`, ["plugins", index]);
        else if (role === "subagent" && parent !== undefined && !parent.some((item) => item.name === name))
          fail("plugin_subset", `${name}, and the agent that holds this subagent does not declare it: a subagent's plugins are a subset of its parent's`, ["plugins", index]);
        else names.push(name);
      }
  }
  // mcpServers.nylorun: the declared plugins' tools, turned off one by one, or all with "*".
  const off = new Set<string>();
  const servers = isObject(front.mcpServers) ? front.mcpServers : undefined;
  const settings = servers?.[RUNTIME_SERVER];
  if (settings !== undefined) {
    const at = ["mcpServers", RUNTIME_SERVER];
    const known = names.flatMap(pluginTools);
    if (!isObject(settings) || Object.keys(settings).some((key) => key !== "tools"))
      fail("value_invalid", "mcpServers.nylorun takes tools: each declared plugin's tool, { enabled: false } to turn it off", at);
    else if (settings.tools !== undefined) {
      if (!isObject(settings.tools)) fail("value_invalid", "mcpServers.nylorun.tools is a map of tool names to { enabled: false }", [...at, "tools"]);
      else
        for (const [tool, value] of Object.entries(settings.tools)) {
          if (tool !== "*" && !known.includes(tool)) {
            const close = suggestion(tool, known);
            fail("tool_unknown", `${tool} is not a tool of the plugins this folder declares (${known.join(", ") || "none"}).${close ? ` Did you mean '${close}'?` : ""}`, [...at, "tools", tool], { key: true });
            continue;
          }
          if (!isObject(value) || Object.keys(value).some((key) => key !== "enabled") || typeof value.enabled !== "boolean") {
            fail("value_invalid", `mcpServers.nylorun.tools.${tool} is { enabled: true } or { enabled: false }`, [...at, "tools", tool]);
            continue;
          }
          if (value.enabled === false) for (const name of tool === "*" ? known : [tool]) off.add(name);
          else if (tool !== "*") off.delete(tool);
        }
    }
  }
  if (!valid) return undefined;
  const plugins = names.map((name) => {
    const tools = pluginTools(name).filter((tool) => !off.has(tool));
    const within = parent?.find((item) => item.name === name);
    return { name, tools: within ? tools.filter((tool) => within.tools.includes(tool)) : tools };
  });
  const on = (tool: string) => plugins.some((plugin) => plugin.tools.includes(tool));
  const loop = Object.fromEntries(
    ([["plan", "update_plan"], ["connections", "request_connection"], ["ask", "ask"]] as const).flatMap(([key, tool]) => (role === "root" && on(tool) ? [[key, true]] : [])),
  );
  const engine: Record<string, unknown> = {
    ...(isObject(front.engine) ? front.engine : {}),
    sandbox: SANDBOX_TOOL_NAMES.filter((tool) => on(tool)),
    artifacts: { read: on("read_artifact"), save: computer && on("save_artifact") },
    ...(role === "root" && on("triggers") ? { triggers: true } : {}),
  };
  return {
    plugins,
    ...(role === "root" && on("memory") ? { memory: { access: "read_write" } } : {}),
    ...(Object.keys(loop).length > 0 ? { loop } : {}),
    engine,
  };
}

/** `harness.engine.plugins`: each declared plugin with its tools, its hash, and the sandbox's hosts. */
export function enginePlugins(
  plugins: readonly { readonly name: PluginName; readonly tools: readonly string[] }[],
  hosts: readonly string[] | undefined,
): HarnessEnginePlugin[] {
  return plugins.map((plugin) => ({
    name: plugin.name,
    tools: [...plugin.tools],
    sha256: pluginOf(plugin.name).sha256,
    ...(plugin.name === "nylorun-sandbox" && hosts !== undefined && hosts.length > 0 ? { hosts: [...hosts] } : {}),
  }));
}

/** The names of the declared plugins' skills, which a folder's own skill may not take. */
export function pluginSkillNames(plugins: readonly { readonly name: PluginName }[]): string[] {
  return pluginSkills(plugins.map((plugin) => plugin.name)).map((skill) => skill.name);
}
