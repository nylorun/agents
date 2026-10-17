/**
 * The Manifest tab's Declared view of what a session runs: the loop manifest it pinned (its
 * Agent's agent manifest version's harness section, flat), with the agent's instructions, tools,
 * skills and MCP servers, each skill and server with the plugin that brought it. The harness adds the sandbox
 * and skill tools and their text when it runs a turn. Pure, so `scripts/manifest-model.test.mjs` runs it without a
 * browser.
 */

/** The tools our harness offers in a session with a sandbox (its `sandboxTools`). */
export const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

/** `code`: a tool that would run your code, which the Runtime refuses at save (track R2). */
export type ToolKind = "code" | "http" | "subagent" | "flow-subagent";

export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
};

export type ToolView = {
  name: string;
  description?: string;
  kind: ToolKind;
  input: SchemaField[];
  output?: SchemaField[];
  /** An HTTP tool's request, which the Runtime makes. */
  http?: { method: string; url: string };
  /** Each call waits for approval. */
  approval?: true;
};

/** The Agent Plugin that brought a skill or a server: its `plugin.json` name and version. */
export type PluginLabel = { name: string; version?: string };

export type SkillView = {
  name: string;
  description?: string;
  /** The paths of the skill's files (names only). */
  files: string[];
  plugin?: PluginLabel;
};

export type McpServerView = {
  name: string;
  url?: string;
  plugin?: PluginLabel;
  /** Every tool call waits for approval (a manifest saved before R5 step 2). */
  approval?: true;
};

export type ManifestView = {
  description?: string;
  instructions: string[];
  tools: ToolView[];
  skills: SkillView[];
  mcpServers: McpServerView[];
  /** Every plugin a skill or server names, once each, in order of appearance. */
  plugins: PluginLabel[];
};

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON Schema's type as one short word: `string`, `number[]`, `"a" | "b"`, `object`. */
export function schemaType(schema: unknown): string {
  if (!isRecord(schema)) return "any";
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  const union = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(union)) return union.map(schemaType).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") return `${schemaType(schema.items)}[]`;
  if (type === "integer") return "integer";
  return typeof type === "string" ? type : isRecord(schema.properties) ? "object" : "any";
}

/** The top-level fields of an object schema; a non-object schema is one unnamed field. */
export function schemaFields(schema: unknown): SchemaField[] {
  if (!isRecord(schema)) return [];
  if (!isRecord(schema.properties)) {
    const type = schemaType(schema);
    return type === "any" ? [] : [{ name: "", type, required: true }];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    type: schemaType(property),
    required: required.has(name),
  }));
}

function toolView(tool: Json): ToolView {
  const name = String(tool.name);
  const agent = tool.agent;
  const http = isRecord(tool.http) ? tool.http : undefined;
  const kind: ToolKind = isRecord(agent)
    ? agent.kind === "workflow"
      ? "flow-subagent"
      : "subagent"
    : http
      ? "http"
      : "code";
  const output = tool.outputSchema ?? tool.output;
  return {
    name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    kind,
    input: schemaFields(tool.inputSchema ?? tool.input),
    ...(output === undefined ? {} : { output: schemaFields(output) }),
    ...(http
      ? { http: { method: typeof http.method === "string" ? http.method : "POST", url: String(http.url) } }
      : {}),
    ...(tool.approval === "always" ? { approval: true as const } : {}),
  };
}

function toolsOf(value: unknown): ToolView[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).map((tool) => toolView(tool));
}

function instructionsOf(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pluginOf(value: unknown): { plugin?: PluginLabel } {
  if (!isRecord(value) || typeof value.name !== "string") return {};
  return {
    plugin: {
      name: value.name,
      ...(typeof value.version === "string" ? { version: value.version } : {}),
    },
  };
}

/** A plugin as its badge reads: `name version`, or the name alone. */
export function pluginText(plugin: PluginLabel): string {
  return plugin.version === undefined ? plugin.name : `${plugin.name} ${plugin.version}`;
}

export function manifestView(manifest: unknown): ManifestView {
  const root = isRecord(manifest) ? manifest : {};
  const skills: SkillView[] = isRecord(root.skills)
    ? Object.values(root.skills)
        .filter(isRecord)
        .map((skill) => ({
          name: String(skill.name),
          ...(typeof skill.description === "string" ? { description: skill.description } : {}),
          files: isRecord(skill.files) ? Object.keys(skill.files).sort() : [],
          ...pluginOf(skill.plugin),
        }))
    : [];
  const mcpServers: McpServerView[] = isRecord(root.mcpServers)
    ? Object.entries(root.mcpServers)
        .filter((entry): entry is [string, Json] => isRecord(entry[1]))
        .map(([name, server]) => ({
          name,
          ...(typeof server.url === "string" ? { url: server.url } : {}),
          ...pluginOf(server.plugin),
          ...(server.approval === "always" ? { approval: true as const } : {}),
        }))
    : [];
  const plugins = new Map<string, PluginLabel>();
  for (const item of [...skills, ...mcpServers])
    if (item.plugin && !plugins.has(pluginText(item.plugin)))
      plugins.set(pluginText(item.plugin), item.plugin);
  return {
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    instructions: instructionsOf(root.instructions),
    tools: toolsOf(root.tools),
    skills,
    mcpServers,
    plugins: [...plugins.values()],
  };
}

/**
 * Which skills and servers to show: all, the agent's own (`own`: no plugin), or one plugin's
 * (named as `pluginText` reads it).
 */
export type PluginFilter = "all" | "own" | string;

export function byPlugin<T extends { plugin?: PluginLabel }>(
  items: readonly T[],
  filter: PluginFilter,
): T[] {
  if (filter === "all") return [...items];
  if (filter === "own") return items.filter((item) => item.plugin === undefined);
  return items.filter((item) => item.plugin !== undefined && pluginText(item.plugin) === filter);
}

/** The first 12 characters of a manifest hash, enough to tell versions apart. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** An agent manifest's version: `triage` v3. */
export type ManifestVersion = { name: string; version: number };

export type PinnedManifestState =
  /**
   * The Runtime returned the session's own loop manifest, with the agent manifest version it
   * pinned (absent for a session opened from a definition before protocol 16) and that
   * manifest's latest version, when known.
   */
  | {
      kind: "pinned";
      manifest: unknown;
      manifestHash: string;
      version?: ManifestVersion;
      latest?: number;
    }
  /**
   * The Runtime has no `session-reads`: the harness section of the version the session's Agent
   * runs, which the session pinned when it opened.
   */
  | { kind: "agent"; manifest: unknown; version: ManifestVersion; latest?: number }
  | { kind: "loading" }
  | { kind: "failed"; message: string };

/**
 * True when the session runs an older version of its agent manifest than the latest: its next
 * turn runs the version its Agent runs then, which moves when it tracks the manifest or is moved.
 */
export function isOutdated(
  state: PinnedManifestState,
): state is Extract<PinnedManifestState, { version?: ManifestVersion }> & {
  version: ManifestVersion;
  latest: number;
} {
  return (
    (state.kind === "pinned" || state.kind === "agent") &&
    state.version !== undefined &&
    state.latest !== undefined &&
    state.latest > state.version.version
  );
}

/** One schema field as a TypeScript-like member: `orderId: string`, `note?: string`. */
export function fieldText(field: SchemaField): string {
  return field.name ? `${field.name}${field.required ? "" : "?"}: ${field.type}` : field.type;
}

export type ManifestStats = {
  tools: number;
  subagents: number;
  skills: number;
  mcpServers: number;
};

/** Totals for the overview: the author's tools, not the ones the Runtime adds. */
export function manifestStats(view: ManifestView): ManifestStats {
  return {
    tools: view.tools.filter((tool) => tool.kind === "code" || tool.kind === "http").length,
    subagents: view.tools.filter((tool) => tool.kind === "subagent" || tool.kind === "flow-subagent")
      .length,
    skills: view.skills.length,
    mcpServers: view.mcpServers.length,
  };
}
