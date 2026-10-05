/**
 * The Agent Manifest tab's view of a published agent manifest: capabilities with their own
 * instructions, tools and hooks, tools sorted by where they run, and compact schema fields.
 * Pure, so `scripts/manifest-model.test.mjs` runs it without a browser.
 */

export type HookAt = "before" | "after";
export type HookScope = "turn" | "step";

/** The SDK builder method for a hook point, as authors write it. */
export function hookMethod(hook: { at: HookAt; scope: HookScope }): string {
  if (hook.at === "before") return hook.scope === "turn" ? "beforeTurn" : "beforeModel";
  return hook.scope === "turn" ? "afterTurn" : "afterModel";
}

/** How often a hook point runs, so the cost of each hook is visible. */
export function hookFrequency(hook: { scope: HookScope }): string {
  return hook.scope === "turn" ? "once per turn" : "every model call";
}

/** Tools the engine adds for a skills catalog; not the author's code. */
const SKILL_TOOLS = new Set(["load_skill", "read_skill_resource"]);

/** Tools the Runtime runs in a session's sandbox (core `createSandboxTools`). */
export const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

export type ToolKind = "endpoint" | "subagent" | "flow-subagent" | "built-in";

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
};

export type CapabilityView = {
  id: string;
  type: string;
  description?: string;
  instructions: string[];
  tools: ToolView[];
  hooks: { method: string; frequency: string }[];
  skills: { name: string; description?: string }[];
  mcpServers: string[];
};

export type ManifestView = {
  description?: string;
  capabilities: CapabilityView[];
  /** Every hook point with the capabilities registered on it, in the order the engine runs them. */
  hookPoints: { method: string; frequency: string; capabilityIds: string[] }[];
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
  const kind: ToolKind = isRecord(agent)
    ? agent.kind === "workflow"
      ? "flow-subagent"
      : "subagent"
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
  };
}

function instructionsOf(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const HOOK_ORDER = ["beforeTurn", "beforeModel", "afterModel", "afterTurn"];

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
      hooks: (Array.isArray(capability.hooks) ? capability.hooks : [])
        .filter(isRecord)
        .map((hook) => {
          const point = { at: hook.at as HookAt, scope: hook.scope as HookScope };
          return { method: hookMethod(point), frequency: hookFrequency(point) };
        }),
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
    }));
  const points = new Map<string, { method: string; frequency: string; capabilityIds: string[] }>();
  for (const capability of capabilities)
    for (const hook of capability.hooks) {
      const point = points.get(hook.method) ?? { ...hook, capabilityIds: [] };
      point.capabilityIds.push(capability.id);
      points.set(hook.method, point);
    }
  return {
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    capabilities,
    hookPoints: [...points.values()].sort(
      (a, b) => HOOK_ORDER.indexOf(a.method) - HOOK_ORDER.indexOf(b.method),
    ),
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
export function isOutdated(state: PinnedManifestState): boolean {
  return (
    state.kind === "pinned" &&
    state.registeredHash !== undefined &&
    state.registeredHash !== state.manifestHash
  );
}
