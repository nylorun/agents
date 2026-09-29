import { HarnessError } from "../errors.js";
import type {
  AgentManifest,
  CapabilityManifest,
  McpServerManifest,
  SkillManifest,
  ToolManifest,
} from "../types/manifest.js";
import type { BuiltAgent } from "../types/agent.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { Implementations } from "./implementations.js";
import { assembleAgent } from "./assemble.js";
import type { CapabilityDynamics } from "./assemble.js";
import { schemaFromJSON } from "./schema-json.js";
import { copyJsonObject, deepFreeze } from "../utils/immutable.js";
import type { BoundMiddleware } from "./bound.js";
import { HOOK_POINTS, hasHook, hookListIssue } from "./hooks.js";
import { delegateFromManifest, delegateOf } from "./delegate.js";

/** A tool that exists for one execution and is not part of the hashed manifest. */
export interface SessionToolRef {
  readonly capabilityId: string;
  readonly name: string;
}

/** Rebuild an agent from manifest JSON + in-process implementations (T28). */
export function agentFrom<Info = unknown>(
  json: AgentManifest | JsonObject,
  implementations: Implementations<Info>,
  options?: { readonly sessionTools?: readonly SessionToolRef[] }
): BuiltAgent<Info> {
  const manifest = normalizeManifest(json);
  const sessionTools = options?.sessionTools ?? [];
  assertSessionTools(manifest, sessionTools);
  const entries: BoundMiddleware[] = [];
  const dynamics = new Map<string, CapabilityDynamics>();

  for (const capability of manifest.capabilities) {
    const impl = implementations[capability.id] ?? {};
    const tools = resolveTools(capability, impl.tools);
    const session = sessionTools
      .filter((item) => item.capabilityId === capability.id)
      .map((item) => {
        const live = impl.tools?.[item.name];
        if (!live)
          throw new HarnessError(
            "agent.build-failed",
            `Missing session tool implementation '${item.name}' for capability '${capability.id}'`
          );
        return live;
      });
    assertHookImplementations(capability, impl);
    const handle: StepMiddleware =
      (impl.middleware as StepMiddleware | undefined) ??
      (async (request, next) => {
        const advertised = [...tools, ...session];
        if (advertised.length)
          request.configuration.tools.set(
            capability.id,
            advertised.map(
              (tool) =>
                (delegateOf(tool)
                  ? tool
                  : implementations[capability.id]?.tools?.[tool.name]) ?? tool
            )
          );
        if (capability.instructions)
          request.configuration.instructions.set(
            capability.id,
            capability.instructions
          );
        return next();
      });
    entries.push(
      Object.freeze({
        id: capability.id,
        ...(capability.name === undefined ? {} : { name: capability.name }),
        ...(capability.description === undefined
          ? {}
          : { description: capability.description }),
        handle,
        hasMiddleware: impl.middleware !== undefined,
        tools:
          capability.tools !== undefined
            ? tools.map((tool) => {
                const live = delegateOf(tool) ? tool : impl.tools?.[tool.name];
                if (!live)
                  throw new HarnessError(
                    "agent.build-failed",
                    `Missing tool implementation '${tool.name}' for capability '${capability.id}'`
                  );
                return live;
              })
            : undefined,
        ...(session.length === 0 ? {} : { sessionTools: session }),
        contributions: Object.freeze({
          ...(capability.instructions
            ? { instructions: capability.instructions }
            : {}),
          ...(capability.tools
            ? {
                tools: capability.tools.map((tool) =>
                  Object.freeze({
                    name: tool.name,
                    ...(tool.description === undefined
                      ? {}
                      : { description: tool.description }),
                  })
                ),
              }
            : {}),
        }),
        ...(capability.hooks === undefined ? {} : { hooks: capability.hooks }),
        manifestType: capability.type,
        ...(capability.metadata === undefined
          ? {}
          : { metadata: capability.metadata }),
        ...(capability.mcpServers === undefined
          ? {}
          : { mcpServers: capability.mcpServers }),
        ...(capability.sandbox === undefined
          ? {}
          : { sandbox: capability.sandbox }),
        ...(capability.skills === undefined
          ? {}
          : { skills: capability.skills }),
      })
    );
    dynamics.set(capability.id, {
      ...(impl.before ? { before: impl.before as any } : {}),
      ...(impl.after ? { after: impl.after as any } : {}),
      ...(impl.middleware ? { middleware: impl.middleware as any } : {}),
    });
  }

  const outputSchema = manifest.outputSchema
    ? schemaFromJSON(manifest.outputSchema)
    : undefined;

  const result = assembleAgent(
    entries,
    {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      metadata: manifest.metadata,
      outputSchema,
      runtime: manifest.runtime,
    },
    dynamics
  );
  if (!result.ok)
    throw new HarnessError(
      "agent.build-failed",
      result.diagnostics.map((item) => item.message).join("; ")
    );
  return result.agent as BuiltAgent<Info>;
}

function assertSessionTools(
  manifest: AgentManifest,
  sessionTools: readonly SessionToolRef[]
): void {
  const seen = new Set<string>();
  for (const item of sessionTools) {
    if (seen.has(item.name))
      throw new HarnessError(
        "agent.build-failed",
        `Duplicate session tool '${item.name}'`
      );
    seen.add(item.name);
    const capability = manifest.capabilities.find(
      (entry) => entry.id === item.capabilityId
    );
    if (!capability)
      throw new HarnessError(
        "agent.build-failed",
        `Session tool '${item.name}' references unknown capability '${item.capabilityId}'`
      );
    if (capability.tools?.some((tool) => tool.name === item.name))
      throw new HarnessError(
        "agent.build-failed",
        `Session tool '${item.name}' collides with a declared tool`
      );
  }
}

function resolveTools(
  capability: CapabilityManifest,
  tools: Implementations[string]["tools"] | undefined
): ToolDefinition[] {
  if (!capability.tools?.length) return [];
  return capability.tools.flatMap((declared) => {
    const live = tools?.[declared.name];
    // The engine runs agents used as tools; an authored delegate keeps its local child.
    if (declared.agent)
      return [
        live && delegateOf(live)?.manifest.id === declared.agent.id
          ? live
          : delegateFromManifest(declared.agent, declared),
      ];
    if (live) return [live];
    if (
      (declared.name === "load_skill" || declared.name === "read_skill_resource") &&
      capability.skills &&
      Object.keys(capability.skills).length > 0
    )
      return [];
    throw new HarnessError(
      "agent.build-failed",
      `Missing tool implementation '${declared.name}' for capability '${capability.id}'`
    );
  });
}

function assertHookImplementations(
  capability: CapabilityManifest,
  impl: Implementations<any>[string]
): void {
  for (const point of HOOK_POINTS) {
    const declared = hasHook(capability.hooks, point.at, point.scope);
    const live = impl[point.at]?.[point.scope] !== undefined;
    if (declared && !live)
      throw new HarnessError(
        "agent.build-failed",
        `Missing ${point.at}("${point.scope}") implementation for capability '${capability.id}'`
      );
    if (live && !declared)
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capability.id}' implements ${point.at}("${point.scope}") but the manifest does not declare it`
      );
  }
}

function normalizeManifest(json: AgentManifest | JsonObject): AgentManifest {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new HarnessError(
      "agent.build-failed",
      "Agent.from requires a manifest object"
    );
  const value = json as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest id must be a non-empty string"
    );
  if ("name" in value && value.name !== undefined) {
    if (typeof value.name !== "string" || !value.name)
      throw new HarnessError(
        "agent.build-failed",
        "Manifest name must be a non-empty string"
      );
  }
  if (!Array.isArray(value.capabilities))
    throw new HarnessError(
      "agent.build-failed",
      "Manifest capabilities must be an array"
    );
  if ("schemaVersion" in value && value.schemaVersion !== undefined)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest field schemaVersion was renamed to manifestSchemaVersion"
    );
  if (value.manifestSchemaVersion !== 4)
    throw new HarnessError(
      "agent.build-failed",
      value.manifestSchemaVersion === 3
        ? "manifestSchemaVersion 3 is no longer supported; rebuild the agent with before/after hooks (see MIGRATION.md)"
        : `Unsupported manifestSchemaVersion ${String(value.manifestSchemaVersion)}`
    );
  // Reject top-level model (Runtime-owned).
  if ("model" in value && value.model !== undefined)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest must not include top-level model; Runtime owns model resolution"
    );
  if ("description" in value && value.description !== undefined) {
    if (typeof value.description !== "string")
      throw new HarnessError(
        "agent.build-failed",
        "Manifest description must be a string"
      );
  }
  const metadata =
    "metadata" in value && value.metadata !== undefined
      ? copyJsonObject(value.metadata, "metadata")
      : undefined;
  const runtime = normalizeRuntime(value.runtime);
  const capabilities = (value.capabilities as CapabilityManifest[]).map(
    normalizeCapability
  );
  const servers = new Set<string>();
  for (const capability of capabilities)
    for (const name of Object.keys(capability.mcpServers ?? {})) {
      if (servers.has(name))
        throw new HarnessError(
          "agent.build-failed",
          `Duplicate MCP server '${name}'`
        );
      servers.add(name);
    }
  return deepFreeze({
    manifestSchemaVersion: 4 as const,
    id: value.id,
    ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(metadata === undefined ? {} : { metadata }),
    ...(value.outputSchema && typeof value.outputSchema === "object"
      ? { outputSchema: value.outputSchema as JsonObject }
      : {}),
    capabilities,
    ...(runtime === undefined ? {} : { runtime }),
  });
}

function normalizeRuntime(value: unknown) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  )
    throw new HarnessError(
      "agent.build-failed",
      "runtime must be an empty object when present"
    );
  return {};
}

function normalizeCapability(
  capability: CapabilityManifest
): CapabilityManifest {
  const raw = capability as CapabilityManifest & {
    name?: unknown;
    description?: unknown;
  };
  if ("name" in raw && raw.name !== undefined) {
    if (typeof raw.name !== "string" || !raw.name)
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capability.id}' name must be a non-empty string`
      );
  }
  if ("description" in raw && raw.description !== undefined) {
    if (typeof raw.description !== "string")
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capability.id}' description must be a string`
      );
  }
  if ("model" in raw && (raw as { model?: unknown }).model !== undefined)
    throw new HarnessError(
      "agent.build-failed",
      `Capability '${capability.id}' must not include model; Runtime owns model resolution`
    );
  if (capability.type !== "agent" && capability.type !== "agent-plugin")
    throw new HarnessError(
      "agent.build-failed",
      `Capability '${capability.id}' type must be agent or agent-plugin`
    );
  for (const legacy of ["beforeModelCall", "afterModelCall"])
    if (legacy in raw)
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capability.id}' field ${legacy} was replaced by hooks (see MIGRATION.md)`
      );
  if (capability.hooks !== undefined) {
    const issue = hookListIssue(capability.hooks);
    if (issue)
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capability.id}' ${issue}`
      );
  }
  const metadata =
    capability.metadata === undefined
      ? undefined
      : copyJsonObject(capability.metadata, "metadata");
  const mcpServers = normalizeMcpServers(capability.id, capability.mcpServers);
  const skills = normalizeSkills(capability.id, capability.skills);
  return Object.freeze({
    id: capability.id,
    type: capability.type,
    ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
    ...(metadata === undefined ? {} : { metadata }),
    ...(capability.instructions
      ? { instructions: Object.freeze([...capability.instructions]) }
      : {}),
    ...(capability.tools
      ? { tools: Object.freeze(capability.tools.map(normalizeTool)) }
      : {}),
    ...(skills === undefined ? {} : { skills }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(capability.sandbox === undefined
      ? {}
      : {
          sandbox: deepFreeze(
            copyJsonObject(capability.sandbox as unknown as JsonObject, "sandbox")
          ) as CapabilityManifest["sandbox"],
        }),
    ...(capability.hooks === undefined
      ? {}
      : {
          hooks: Object.freeze(
            capability.hooks.map((hook) =>
              Object.freeze({ at: hook.at, scope: hook.scope })
            )
          ),
        }),
  });
}

function normalizeSkills(
  capabilityId: string,
  skills: CapabilityManifest["skills"]
): CapabilityManifest["skills"] {
  if (skills === undefined) return undefined;
  if (
    !skills ||
    typeof skills !== "object" ||
    Array.isArray(skills) ||
    Object.keys(skills).length === 0
  )
    throw new HarnessError(
      "agent.build-failed",
      `Capability '${capabilityId}' skills must be a non-empty map or omitted`
    );
  const normalized: Record<string, SkillManifest> = {};
  for (const [key, skill] of Object.entries(skills)) {
    if (
      !skill ||
      typeof skill !== "object" ||
      skill.name !== key ||
      typeof skill.description !== "string" ||
      skill.description.length === 0
    )
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capabilityId}' skills key '${key}' must equal the skill name`
      );
    normalized[key] = Object.freeze({
      name: skill.name,
      description: skill.description,
    });
  }
  return Object.freeze(normalized);
}

function normalizeMcpServers(
  capabilityId: string,
  servers: CapabilityManifest["mcpServers"]
): CapabilityManifest["mcpServers"] {
  if (servers === undefined) return undefined;
  if (
    !servers ||
    typeof servers !== "object" ||
    Array.isArray(servers) ||
    Object.keys(servers).length === 0
  )
    throw new HarnessError(
      "agent.build-failed",
      `Capability '${capabilityId}' mcpServers must be a non-empty map or omitted`
    );
  const normalized: Record<string, McpServerManifest> = {};
  for (const [key, server] of Object.entries(servers)) {
    if (!isMcpServer(server) || server.name !== key)
      throw new HarnessError(
        "agent.build-failed",
        `Capability '${capabilityId}' mcpServers key '${key}' must equal the server name`
      );
    normalized[key] = server;
  }
  return Object.freeze(normalized);
}

function isMcpServer(value: unknown): value is McpServerManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  if (typeof server.name !== "string" || !server.name) return false;
  if (server.type === "stdio") return typeof server.command === "string" && server.command.length > 0;
  if (server.type === "streamable-http" || server.type === "sse")
    return typeof server.url === "string" && server.url.length > 0;
  return false;
}

function normalizeTool(tool: ToolManifest): ToolManifest {
  return Object.freeze({
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    ...(tool.agent === undefined
      ? {}
      : {
          agent:
            "kind" in tool.agent
              ? deepFreeze(JSON.parse(JSON.stringify(tool.agent)))
              : normalizeManifest(tool.agent as unknown as JsonObject),
        }),
  });
}
