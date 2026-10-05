/**
 * The Agent Manifest tab's view of a published agent manifest: capabilities with their own
 * instructions and tools, tools sorted by where they run, and compact schema fields.
 * Pure, so `scripts/manifest-model.test.mjs` runs it without a browser.
 */

/** Tools the engine adds for a skills catalog; not the author's code. */
const SKILL_TOOLS = new Set(["load_skill", "read_skill_resource"]);

/** Tools the Runtime runs in a session's sandbox (core `createSandboxTools`). */
export const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

export type ToolKind = "endpoint" | "http" | "subagent" | "flow-subagent" | "built-in";

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

export type CapabilityView = {
  id: string;
  type: string;
  description?: string;
  instructions: string[];
  tools: ToolView[];
  skills: { name: string; description?: string }[];
  mcpServers: string[];
  /** The MCP servers whose every tool call waits for approval. */
  mcpApproval: string[];
};

export type ManifestView = {
  description?: string;
  capabilities: CapabilityView[];
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

function toolView(tool: Json, capability: Json): ToolView {
  const name = String(tool.name);
  const agent = tool.agent;
  const http = isRecord(tool.http) ? tool.http : undefined;
  const kind: ToolKind = isRecord(agent)
    ? agent.kind === "workflow"
      ? "flow-subagent"
      : "subagent"
    : http
      ? "http"
      : SKILL_TOOLS.has(name) && isRecord(capability.skills)
        ? "built-in"
        : "endpoint";
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

function instructionsOf(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function manifestView(manifest: unknown): ManifestView {
  const root = isRecord(manifest) ? manifest : {};
  const capabilities = (Array.isArray(root.capabilities) ? root.capabilities : [])
    .filter(isRecord)
    .map((capability): CapabilityView => ({
      id: String(capability.id),
      type: typeof capability.type === "string" ? capability.type : "agent",
      ...(typeof capability.description === "string"
        ? { description: capability.description }
        : {}),
      instructions: instructionsOf(capability.instructions),
      tools: (Array.isArray(capability.tools) ? capability.tools : [])
        .filter(isRecord)
        .map((tool) => toolView(tool, capability)),
      skills: isRecord(capability.skills)
        ? Object.values(capability.skills)
            .filter(isRecord)
            .map((skill) => ({
              name: String(skill.name),
              ...(typeof skill.description === "string"
                ? { description: skill.description }
                : {}),
            }))
        : [],
      mcpServers: isRecord(capability.mcpServers) ? Object.keys(capability.mcpServers) : [],
      mcpApproval: isRecord(capability.mcpServers)
        ? Object.entries(capability.mcpServers)
            .filter(([, server]) => isRecord(server) && server.approval === "always")
            .map(([name]) => name)
        : [],
    }));
  return {
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    capabilities,
  };
}

/** The first 12 characters of a manifest hash, enough to tell versions apart. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export type PinnedManifestState =
  /** The Runtime returned the session's own manifest. */
  | { kind: "pinned"; manifest: unknown; manifestHash: string; registeredHash?: string }
  /** The Runtime has no `session-reads`: only the registered manifest is known. */
  | { kind: "registered-only"; registeredHash?: string }
  | { kind: "loading" }
  | { kind: "failed"; message: string };

/** True when the session runs an older manifest than the one now registered for its agent. */
export function isOutdated(
  state: PinnedManifestState,
): state is Extract<PinnedManifestState, { kind: "pinned" }> & { registeredHash: string } {
  return (
    state.kind === "pinned" &&
    state.registeredHash !== undefined &&
    state.registeredHash !== state.manifestHash
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

/** Totals for the overview. Built-in skill tools count under skills, not tools. */
export function manifestStats(view: ManifestView): ManifestStats {
  const all = view.capabilities.flatMap((capability) => capability.tools);
  return {
    tools: all.filter((tool) => tool.kind === "endpoint" || tool.kind === "http").length,
    subagents: all.filter((tool) => tool.kind === "subagent" || tool.kind === "flow-subagent")
      .length,
    skills: view.capabilities.reduce((sum, capability) => sum + capability.skills.length, 0),
    mcpServers: view.capabilities.reduce(
      (sum, capability) => sum + capability.mcpServers.length,
      0,
    ),
  };
}
