/**
 * Vendored Agent Plugins (track T7, design §3.4): `plugins/<name>/` holds an Agent Plugin exactly
 * as its author published it. The compiler folds it as the SDK's `.plugin()` does: its skills and
 * its `mcp.json` servers join the agent's, each labelled with the plugin's name and version, and
 * `harness.plugins` lists the plugins they came from. Unlike the SDK's loader, which skips an
 * invalid part with a warning, a folder is strict: an invalid skill or server is an error, as in
 * the agent's own `skills/` and `mcp.json`, read by the same code.
 *
 * What a plugin holds that Nylorun does not run (Claude Code's hooks, commands and agents, other
 * tools' settings) is kept with the source and noted.
 */
import type { AgentFolderEntry } from "./compile.js";
import { addInner, foldersUnder, isObject, jsonPosition, quietJson, type FolderContext } from "./context.js";

export const AGENT_PLUGINS_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGINS_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_FILE = "plugin.json";
const PLUGIN_KEYS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
const AUTHOR_KEYS = ["name", "email", "url"];
/** What the compiler reads of a plugin: the rest is kept with the source. */
const READ = new Set([PLUGIN_FILE, "mcp.json", ".mcp.json", "skills"]);
/** Parts of plugins for other tools, which Nylorun does not run. */
const NOT_RUN: Readonly<Record<string, string>> = {
  agents: "Claude Code's subagents (agents/*.md) are not run by Nylorun: write an agent as agents/<id>/ in the agent folder",
  hooks: "Hooks are not run by Nylorun",
  commands: "Slash commands are not run by Nylorun",
  "output-styles": "Output styles are not run by Nylorun",
  ".claude-plugin": "Claude Code's plugin manifest is not read: Nylorun reads the plugin's plugin.json",
  "settings.json": "Plugin settings are not read by Nylorun",
  ".lsp.json": "LSP servers are not run by Nylorun",
};
/** The agent the compiler wraps a plugin's skills and servers in, to read them as an agent's. */
const WRAPPER = new TextEncoder().encode("---\nname: plugin\ndescription: An Agent Plugin's skills and MCP servers.\n---\n");
const isSecretShaped = (base: string) => base === ".env" || base.startsWith(".env.") || base.endsWith(".pem") || base.endsWith(".key");

/** One label: the plugin a skill or server came from. */
export interface PluginLabel {
  readonly name: string;
  readonly version?: string;
}

/** A plugin's skills and servers, labelled, with the file each came from. */
export interface FoldedPlugins {
  readonly servers: Map<string, { readonly server: Record<string, unknown>; readonly file: string }>;
  readonly skills: Map<string, { readonly skill: Record<string, unknown>; readonly file: string }>;
}

/** The files of `plugins/<name>/` the compiler reads, relative to the plugin's folder. */
export function pluginTextPaths(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => path === PLUGIN_FILE || path === "mcp.json" || path === ".mcp.json" || /^skills\/[^/]+\/SKILL\.md$/.test(path),
  );
}

/** Folds every plugin under `plugins/`. */
export function foldPlugins(ctx: FolderContext): FoldedPlugins {
  const folded: FoldedPlugins = { servers: new Map(), skills: new Map() };
  for (const [folder, paths] of foldersUnder("plugins", ctx.entries.keys())) foldPlugin(ctx, folder, paths, folded);
  return folded;
}

function foldPlugin(ctx: FolderContext, folder: string, paths: readonly string[], folded: FoldedPlugins): void {
  const prefix = `plugins/${folder}/`;
  const file = prefix + PLUGIN_FILE;
  const error = (code: string, message: string, at: string, path?: readonly PropertyKey[], key = false) =>
    ctx.report("error", code, message, at, path, { key });
  // What it holds that Nylorun does not read: one note per top-level part.
  const noted = new Set<string>();
  for (const path of paths) {
    const top = path.split("/")[0]!;
    if (READ.has(top) || isSecretShaped(path.split("/").at(-1)!) || noted.has(top)) continue;
    noted.add(top);
    const isFolder = path.includes("/");
    ctx.report(
      "note",
      "plugin_part_ignored",
      `${NOT_RUN[top] ?? "Kept with the source: Nylorun reads a plugin's plugin.json, mcp.json and skills/"}`,
      `${prefix}${top}${isFolder ? "/" : ""}`,
    );
  }
  if (!paths.includes(PLUGIN_FILE)) {
    error("plugin_invalid", `${prefix} has no plugin.json: an Agent Plugin names itself there, with the Agent Plugins $schema and its name`, file);
    return;
  }
  const manifest = ctx.readJson(file);
  if (!manifest) return;
  let valid = true;
  const invalid = (message: string, path: readonly PropertyKey[], key = false) => {
    valid = false;
    error("plugin_invalid", message, file, path, key);
  };
  for (const key of Object.keys(manifest))
    if (!PLUGIN_KEYS.includes(key)) {
      const close = ctx.suggest(key, PLUGIN_KEYS);
      ctx.report("warning", "plugin_unknown_key", `plugin.json has no field '${key}' in Agent Plugins 1.0.0: it is not read.${close ? ` Did you mean '${close}'?` : ""}`, file, [key], { key: true });
    }
  if (manifest.$schema !== AGENT_PLUGINS_PLUGIN_SCHEMA)
    invalid(`plugin.json names the Agent Plugins 1.0.0 plugin schema in $schema (${AGENT_PLUGINS_PLUGIN_SCHEMA})`, manifest.$schema === undefined ? [] : ["$schema"]);
  if (!isPluginName(manifest.name))
    invalid("name is required: 1-64 lowercase letters, digits, hyphens and periods, starting and ending with a letter or digit", manifest.name === undefined ? [] : ["name"]);
  for (const field of ["version", "description", "homepage", "repository", "license"])
    if (manifest[field] !== undefined && typeof manifest[field] !== "string") invalid(`${field} is a string`, [field]);
  if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some((item) => typeof item !== "string")))
    invalid("keywords is a list of strings", ["keywords"]);
  if (manifest.author !== undefined) {
    if (!isObject(manifest.author)) invalid("author is an object: name, email and url", ["author"]);
    else
      for (const [key, value] of Object.entries(manifest.author))
        if (!AUTHOR_KEYS.includes(key) || typeof value !== "string") invalid("author takes name, email and url, each a string", ["author", key], true);
  }
  if (manifest.extensions !== undefined) {
    if (!isObject(manifest.extensions)) ctx.report("warning", "plugin_unknown_key", "extensions is an object of namespaces: it is not read", file, ["extensions"]);
    else
      for (const namespace of Object.keys(manifest.extensions))
        ctx.report("note", "plugin_part_ignored", `The extension namespace '${namespace}' is not run by Nylorun`, file, ["extensions", namespace], { key: true });
  }
  if (!valid) return;
  const label: PluginLabel = { name: manifest.name as string, ...(typeof manifest.version === "string" ? { version: manifest.version } : {}) };

  // mcp.json, as Agent Plugins writes it: with its $schema. Claude Code's .mcp.json when there is none.
  const mcpFile = paths.includes("mcp.json") ? "mcp.json" : paths.includes(".mcp.json") ? ".mcp.json" : undefined;
  if (mcpFile === "mcp.json" && paths.includes(".mcp.json"))
    ctx.report("note", "plugin_part_ignored", "Claude Code's server file is not read: the plugin's mcp.json is", `${prefix}.mcp.json`);
  if (mcpFile === "mcp.json") {
    const value = quietJson(ctx, prefix + "mcp.json");
    if (value && value.$schema === undefined)
      ctx.report("error", "plugin_invalid", `A plugin's mcp.json names the Agent Plugins MCP schema in $schema (${AGENT_PLUGINS_MCP_SCHEMA}), as Agent Plugins requires`, prefix + "mcp.json", [], {
        at: jsonPosition(ctx, prefix + "mcp.json", []),
      });
  }

  // Its skills and servers, read as an agent's own by the compiler itself, inside a wrapper.
  const entries: AgentFolderEntry[] = [{ path: "AGENT.md", size: WRAPPER.byteLength, sha256: "0".repeat(64) }];
  const files = new Map<string, Uint8Array>([["AGENT.md", WRAPPER]]);
  const real = (path: string) => (path === "mcp.json" && mcpFile ? prefix + mcpFile : prefix + path);
  const take = (inner: string, path: string) => {
    const entry = ctx.entries.get(prefix + path);
    if (!entry) return;
    entries.push({ ...entry, path: inner });
    const bytes = ctx.files.get(prefix + path);
    if (bytes) files.set(inner, bytes);
  };
  if (mcpFile) take("mcp.json", mcpFile);
  for (const path of paths)
    if (path.startsWith("skills/") || (!READ.has(path.split("/")[0]!) && isSecretShaped(path.split("/").at(-1)!))) take(path, path);
  const result = ctx.compile(
    { entries, files },
    {
      role: "plugin",
      deriveSlot: (credential, type, url, at, position, header) => ctx.deriveSlot(credential, type, url, real(at), [], header, position),
      schema: () => ({ code: "schema_invalid", message: "A plugin's skills and servers name no schema files" }),
    },
  );
  addInner(
    ctx,
    prefix,
    result.diagnostics.filter((item) => item.file !== "AGENT.md"),
    real,
  );
  const harness = result.manifest?.harness as { mcpServers?: Record<string, Record<string, unknown>>; skills?: Record<string, Record<string, unknown>> } | undefined;
  if (!harness) return;
  for (const [key, server] of Object.entries(harness.mcpServers ?? {})) {
    const at = real("mcp.json");
    const other = folded.servers.get(key);
    if (other) {
      error("plugin_duplicate", `MCP server ${key} is also in ${other.file}: an agent has one server of a name`, at, ["mcpServers", key], true);
      continue;
    }
    folded.servers.set(key, { server: { ...server, plugin: label }, file: at });
  }
  for (const [key, skill] of Object.entries(harness.skills ?? {})) {
    const at = `${prefix}skills/${key}/SKILL.md`;
    const other = folded.skills.get(key);
    if (other) {
      error("plugin_duplicate", `Skill ${key} is also in ${other.file}: an agent has one skill of a name`, at);
      continue;
    }
    folded.skills.set(key, { skill: { ...skill, plugin: label }, file: at });
  }
}

/** An Agent Plugins name: 1-64 lowercase letters, digits, hyphens and periods (the SDK loader's rule). */
function isPluginName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  if (value.length === 1) return /^[a-z0-9]$/.test(value);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && !value.includes("--") && !value.includes("..");
}
