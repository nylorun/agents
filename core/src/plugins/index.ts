/**
 * The Runtime's own Agent Plugins (ADR-106, D84): six plugins, one per Runtime primitive, which an
 * `agent-folder/3` folder declares by name (`plugins:`) and which share one reserved server,
 * `nylorun`. Their files are in `core/plugins/`; `bundle.generated.ts` holds them as data, so the
 * compiler, the engine's projection, the harness and the Runtime read the same bytes offline.
 *
 * A plugin's tools keep their effects: the model calls `nylorun__memory`, and the effect is the
 * `memory` operation the Runtime serves, as without plugins. Only the name the model reads, and
 * where the words come from, change.
 */
import { PLUGIN_BUNDLE } from "./bundle.generated.js";

/** The reserved server the Runtime's plugins share; no other plugin or `mcp.json` may name it. */
export const RUNTIME_SERVER = "nylorun";
/** What the model's tool names begin with: `nylorun__memory`. */
export const RUNTIME_TOOL_PREFIX = `${RUNTIME_SERVER}__`;

/** The Runtime's plugins, in the order their words reach the model. */
export const PLUGIN_NAMES = [
  "nylorun-memory",
  "nylorun-triggers",
  "nylorun-plan",
  "nylorun-interactions",
  "nylorun-artifacts",
  "nylorun-sandbox",
] as const;
export type PluginName = (typeof PLUGIN_NAMES)[number];

/** What runs a plugin tool's calls: the Runtime (`runtime`), the harness, or the sandbox. */
export type PluginToolEffect = "runtime" | "harness" | "sandbox";

export interface RuntimePlugin {
  readonly name: PluginName;
  readonly description: string;
  readonly tools: readonly { readonly name: string; readonly effect: PluginToolEffect }[];
  /** `computer`: the plugin needs a computer in `runtime.json`. */
  readonly requires: readonly string[];
  /** Its words, by section: `_` when any tool is on, `<tool>` when that tool is on. */
  readonly instructions: Readonly<Record<string, string>>;
  readonly skills: Readonly<Record<string, { readonly name: string; readonly description: string; readonly body: string; readonly text: string }>>;
  /** `sha256:<hex>` of the plugin's files. */
  readonly sha256: string;
}

export function isPluginName(value: unknown): value is PluginName {
  return typeof value === "string" && (PLUGIN_NAMES as readonly string[]).includes(value);
}

/** One of the Runtime's plugins. */
export function pluginOf(name: PluginName): RuntimePlugin {
  return { name, ...(PLUGIN_BUNDLE[name] as unknown as Omit<RuntimePlugin, "name">) };
}

/** Every tool name of `name`, in its order. */
export function pluginTools(name: PluginName): string[] {
  return pluginOf(name).tools.map((tool) => tool.name);
}

/** The plugin a tool belongs to. */
export function pluginOfTool(tool: string): PluginName | undefined {
  return PLUGIN_NAMES.find((name) => pluginTools(name).includes(tool));
}

/** The name the model reads for a plugin's tool: `nylorun__<tool>`. */
export function runtimeToolName(tool: string): string {
  return `${RUNTIME_TOOL_PREFIX}${tool}`;
}

/** A plugin tool's own name from the name the model reads, or undefined for any other name. */
export function runtimeToolOf(modelName: string): string | undefined {
  if (!modelName.startsWith(RUNTIME_TOOL_PREFIX)) return undefined;
  const tool = modelName.slice(RUNTIME_TOOL_PREFIX.length);
  return pluginOfTool(tool) === undefined ? undefined : tool;
}

/** The skills of the plugins an agent declares, in plugin order. */
export function pluginSkills(names: readonly PluginName[]): { name: string; description: string; plugin: PluginName; text: string }[] {
  return PLUGIN_NAMES.filter((name) => names.includes(name)).flatMap((name) =>
    Object.values(pluginOf(name).skills).map((skill) => ({ name: skill.name, description: skill.description, plugin: name, text: skill.text })),
  );
}

/** A declared plugin's skill by its name, when one of `names` has it. */
export function pluginSkill(names: readonly PluginName[], skill: string): { name: string; text: string; plugin: PluginName } | undefined {
  return pluginSkills(names).find((item) => item.name === skill);
}

/** How a manifest records a declared plugin (`harness.engine.plugins`). */
export interface DeclaredPlugin {
  readonly name: PluginName;
  /** The plugin's tools left on, in its order. */
  readonly tools: readonly string[];
  /** `sha256:<hex>` of the plugin's files the version was compiled with. */
  readonly sha256: string;
  /** `nylorun-sandbox`: the hosts the runtime allows, from `runtime.json`. */
  readonly hosts?: readonly string[];
}

/** The tools of `declared` that are on, across every plugin. */
export function declaredTools(declared: readonly DeclaredPlugin[] | undefined): string[] {
  return (declared ?? []).flatMap((plugin) => plugin.tools);
}
