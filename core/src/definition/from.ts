import { HarnessError } from "../errors.js";
import type { AgentManifest, CapabilityManifest } from "../types/manifest.js";
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
import { delegateFromManifest, delegateOf } from "./delegate.js";
import { SKILL_TOOL_NAMES } from "./skill-tools.js";
import { httpToolFromManifest, httpToolOf } from "./http-tool.js";
import { AgentManifestSchema } from "../contracts.js";

/** Tools the engine or the Runtime runs, which need no implementation: agents and HTTP tools. */
const declarative = (tool: ToolDefinition) =>
  delegateOf(tool) !== undefined || httpToolOf(tool) !== undefined;

/** A tool that exists for one execution and is not part of the hashed manifest. */
export interface SessionToolRef {
  readonly capabilityId: string;
  readonly name: string;
  /**
   * Text the model reads with the capability's instructions while the tool is advertised, such
   * as `tool_search`'s note of the servers whose tools are deferred (R2b C10). Not hashed.
   */
  readonly instructions?: readonly string[];
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
    const owned = sessionTools.filter((item) => item.capabilityId === capability.id);
    const instructions = [
      ...(capability.instructions ?? []),
      ...owned.flatMap((item) => item.instructions ?? []),
    ];
    const session = owned
      .map((item) => {
        const live = impl.tools?.[item.name];
        if (!live)
          throw new HarnessError(
            "agent.build-failed",
            `Missing session tool implementation '${item.name}' for capability '${capability.id}'`
          );
        return live;
      });
    const handle: StepMiddleware =
      (impl.middleware as StepMiddleware | undefined) ??
      (async (request, next) => {
        const advertised = [...tools, ...session];
        if (advertised.length)
          request.configuration.tools.set(
            capability.id,
            advertised.map(
              (tool) =>
                (declarative(tool)
                  ? tool
                  : implementations[capability.id]?.tools?.[tool.name]) ?? tool
            )
          );
        if (instructions.length > 0)
          request.configuration.instructions.set(capability.id, instructions);
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
                const live = declarative(tool) ? tool : impl.tools?.[tool.name];
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
    dynamics.set(capability.id, impl.middleware ? { middleware: impl.middleware as any } : {});
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
      manifestSchemaVersion: manifest.manifestSchemaVersion,
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
    // The Runtime runs HTTP tools; a host's own (its engine's routing) is kept.
    if (declared.http)
      return [
        live && httpToolOf(live)
          ? live
          : httpToolFromManifest({ ...declared, http: declared.http }),
      ];
    if (live) return [live];
    // The build attaches the skill tools again; the Runtime serves them.
    if (
      SKILL_TOOL_NAMES.has(declared.name) &&
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

/**
 * The manifest as `AgentManifestSchema` accepts it (the Runtime's own check), as a frozen copy.
 * A refusal is `agent.build-failed` with the schema's messages.
 */
function normalizeManifest(json: AgentManifest | JsonObject): AgentManifest {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new HarnessError(
      "agent.build-failed",
      "Agent.from requires a manifest object"
    );
  const parsed = AgentManifestSchema.safeParse(json);
  if (!parsed.success)
    throw new HarnessError(
      "agent.build-failed",
      parsed.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.join(".")}: ${issue.message}`
        )
        .join("; ")
    );
  // The schema checks no value of a JSON object; metadata must be JSON data, as before.
  const manifest = parsed.data;
  for (const metadata of [
    manifest.metadata,
    ...manifest.capabilities.map((capability) => capability.metadata),
  ])
    if (metadata !== undefined) copyJsonObject(metadata, "metadata");
  return deepFreeze(JSON.parse(JSON.stringify(manifest)) as AgentManifest);
}
