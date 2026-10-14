/**
 * The Agent Manifest tab's view of an agent manifest (v7, flat): the agent's instructions, tools,
 * skills and MCP servers, each skill and server with the plugin that brought it, and for a
 * session's pinned manifest the `runtime` block the Runtime added (sandbox, tools, instructions).
 * Pure, so `scripts/manifest-model.test.mjs` runs it without a browser.
 */

/** Tools the Runtime runs in a session's sandbox (core `createSandboxTools`). */
export const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

/**
 * `code`: a tool that would run your code, which the Runtime refuses at save (track R2).
 * `runtime`: a tool of the pinned manifest's `runtime` block, which the Runtime serves.
 */
export type ToolKind = "code" | "http" | "subagent" | "flow-subagent" | "runtime";

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

/** What the Runtime added when it pinned the session's agent (`manifest.runtime`). */
export type RuntimeView = {
  /** The sandbox spec, one short line per setting; absent without a sandbox. */
  sandbox?: string[];
  tools: ToolView[];
  instructions: string[];
};

export type ManifestView = {
  description?: string;
  instructions: string[];
  tools: ToolView[];
  skills: SkillView[];
  mcpServers: McpServerView[];
  /** Every plugin a skill or server names, once each, in order of appearance. */
  plugins: PluginLabel[];
  runtime?: RuntimeView;
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

function toolView(tool: Json, runtime = false): ToolView {
  const name = String(tool.name);
  const agent = tool.agent;
  const http = isRecord(tool.http) ? tool.http : undefined;
  const kind: ToolKind = runtime
    ? "runtime"
    : isRecord(agent)
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

function toolsOf(value: unknown, runtime = false): ToolView[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).map((tool) => toolView(tool, runtime));
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

/** A sandbox spec as short lines: image, network, resources, idle; Runtime defaults when empty. */
export function sandboxSummary(sandbox: unknown): string[] {
  const spec = isRecord(sandbox) ? sandbox : {};
  const lines: string[] = [];
  if (typeof spec.image === "string") lines.push(`image ${spec.image}`);
  if (isRecord(spec.network)) {
    const allow = Array.isArray(spec.network.allow)
      ? spec.network.allow.filter((host): host is string => typeof host === "string")
      : [];
    const preset = typeof spec.network.preset === "string" ? spec.network.preset : "dev";
    lines.push(`network ${preset}${allow.length ? ` + ${allow.join(", ")}` : ""}`);
  }
  if (isRecord(spec.resources)) {
    const parts = [
      typeof spec.resources.cpus === "number"
        ? `${spec.resources.cpus} cpu${spec.resources.cpus === 1 ? "" : "s"}`
        : "",
      typeof spec.resources.memory === "string" ? spec.resources.memory : "",
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(", "));
  }
  if (typeof spec.idle === "string") lines.push(`stops after ${spec.idle} idle`);
  return lines.length ? lines : ["Runtime defaults"];
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
  const runtime = isRecord(root.runtime) ? root.runtime : undefined;
  return {
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    instructions: instructionsOf(root.instructions),
    tools: toolsOf(root.tools),
    skills,
    mcpServers,
    plugins: [...plugins.values()],
    ...(runtime
      ? {
          runtime: {
            ...("sandbox" in runtime ? { sandbox: sandboxSummary(runtime.sandbox) } : {}),
            tools: toolsOf(runtime.tools, true),
            instructions: instructionsOf(runtime.instructions),
          },
        }
      : {}),
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

export type PinnedManifestState =
  /**
   * The Runtime returned the session's own manifest. `definitionHash` is the definition it was
   * opened from (a newer Runtime's session view): the pinned manifest differs from it by the
   * `runtime` block the Runtime added (sandbox tools, artifact tools, skill tools).
   */
  | {
      kind: "pinned";
      manifest: unknown;
      manifestHash: string;
      definitionHash?: string;
      registeredHash?: string;
    }
  /** The Runtime has no `session-reads`: only the registered manifest is known. */
  | { kind: "registered-only"; registeredHash?: string }
  | { kind: "loading" }
  | { kind: "failed"; message: string };

/**
 * True when the session runs an older manifest than the one now registered for its agent: the
 * definition it was opened from is not the registered one. The `runtime` block the Runtime adds
 * to a session's pin does not make it older.
 */
export function isOutdated(
  state: PinnedManifestState,
): state is Extract<PinnedManifestState, { kind: "pinned" }> & { registeredHash: string } {
  return (
    state.kind === "pinned" &&
    state.registeredHash !== undefined &&
    state.registeredHash !== (state.definitionHash ?? state.manifestHash)
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
