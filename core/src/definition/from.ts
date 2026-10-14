import { HarnessError } from "../errors.js";
import type { AgentManifest, ToolManifest } from "../types/manifest.js";
import type { BuiltAgent } from "../types/agent.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";
import type { Implementations } from "./implementations.js";
import { assembleAgent } from "./assemble.js";
import { schemaFromJSON } from "./schema-json.js";
import { assertJson, deepFreeze } from "../utils/immutable.js";
import type { DefinitionPart } from "./bound.js";
import { delegateFromManifest, delegateOf } from "./delegate.js";
import { httpToolFromManifest, httpToolOf } from "./http-tool.js";
import { RUNTIME_PART_ID } from "./manifest.js";
import { ToolError } from "./tool-error.js";
import { AgentManifestSchema } from "../contracts.js";

/** A tool that exists for one execution and is not part of the hashed manifest. */
export interface SessionToolRef {
  readonly name: string;
  /**
   * Text the model reads while the tool is advertised, such as `tool_search`'s note of the
   * servers whose tools are deferred (R2b C10). Not hashed.
   */
  readonly instructions?: readonly string[];
}

/**
 * Rebuild an agent from its manifest and the code of its tools, by name (T28). Agents used as
 * tools and HTTP tools need no code; neither do the tools in `runtime`, which the Runtime serves.
 * A session tool (`sessionTools`) is offered with the `runtime` part and needs its code.
 */
export function agentFrom<Info = unknown>(
  json: AgentManifest | JsonObject,
  implementations: Implementations<Info>,
  options?: { readonly sessionTools?: readonly SessionToolRef[] }
): BuiltAgent<Info> {
  const manifest = normalizeManifest(json);
  const sessionTools = options?.sessionTools ?? [];
  assertSessionTools(manifest, sessionTools);
  const code = implementations.tools ?? {};
  const parts: DefinitionPart[] = [];
  const own = (manifest.tools ?? []).map((declared) => authoredTool(declared, code[declared.name]));
  if (
    own.length > 0 ||
    manifest.instructions !== undefined ||
    manifest.skills !== undefined ||
    manifest.mcpServers !== undefined
  )
    parts.push(
      Object.freeze({
        id: "agent",
        ...(manifest.tools === undefined ? {} : { tools: own }),
        ...(manifest.instructions === undefined ? {} : { instructions: manifest.instructions }),
        ...(manifest.skills === undefined ? {} : { skills: manifest.skills }),
        ...(manifest.mcpServers === undefined ? {} : { mcpServers: manifest.mcpServers }),
      })
    );
  const runtime = manifest.runtime;
  const session = sessionTools.map((item) => {
    const live = code[item.name];
    if (!live)
      throw new HarnessError("agent.build-failed", `Missing session tool implementation '${item.name}'`);
    return live;
  });
  const sessionInstructions = sessionTools.flatMap((item) => item.instructions ?? []);
  if (runtime !== undefined || session.length > 0)
    parts.push(
      Object.freeze({
        id: RUNTIME_PART_ID,
        ...(runtime?.tools === undefined
          ? {}
          : { tools: runtime.tools.map((declared) => code[declared.name] ?? runtimeTool(declared)) }),
        ...(session.length === 0 ? {} : { sessionTools: session }),
        ...(runtime?.instructions === undefined ? {} : { instructions: runtime.instructions }),
        ...(sessionInstructions.length === 0 ? {} : { sessionInstructions }),
      })
    );

  const outputSchema = manifest.outputSchema
    ? schemaFromJSON(manifest.outputSchema)
    : undefined;

  const result = assembleAgent(parts, {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    metadata: manifest.metadata,
    outputSchema,
    runtime: manifest.runtime,
  });
  if (!result.ok)
    throw new HarnessError(
      "agent.build-failed",
      result.diagnostics.map((item) => item.message).join("; ")
    );
  return result.agent as BuiltAgent<Info>;
}

function assertSessionTools(manifest: AgentManifest, sessionTools: readonly SessionToolRef[]): void {
  const taken = new Set([
    ...(manifest.tools ?? []).map((tool) => tool.name),
    ...(manifest.runtime?.tools ?? []).map((tool) => tool.name),
  ]);
  const seen = new Set<string>();
  for (const item of sessionTools) {
    if (seen.has(item.name))
      throw new HarnessError("agent.build-failed", `Duplicate session tool '${item.name}'`);
    seen.add(item.name);
    if (taken.has(item.name))
      throw new HarnessError(
        "agent.build-failed",
        `Session tool '${item.name}' collides with a declared tool`
      );
  }
}

/**
 * An authored tool: the engine runs agents used as tools (an authored delegate keeps its local
 * child), the Runtime runs HTTP tools (a host's own keeps its routing), and any other tool is the
 * caller's code.
 */
function authoredTool(declared: ToolManifest, live: ToolDefinition | undefined): ToolDefinition {
  if (declared.agent)
    return live && delegateOf(live)?.manifest.id === declared.agent.id
      ? live
      : delegateFromManifest(declared.agent, declared);
  if (declared.http)
    return live && httpToolOf(live) ? live : httpToolFromManifest({ ...declared, http: declared.http });
  if (live) return live;
  throw new HarnessError("agent.build-failed", `Missing tool implementation '${declared.name}'`);
}

/** A tool the Runtime serves, as a process without a Runtime sees it: calling it says so. */
function runtimeTool(declared: ToolManifest): ToolDefinition {
  return Object.freeze({
    name: declared.name,
    ...(declared.description === undefined ? {} : { description: declared.description }),
    inputSchema: schemaFromJSON(declared.inputSchema),
    ...(declared.outputSchema === undefined ? {} : { outputSchema: schemaFromJSON(declared.outputSchema) }),
    async execute(): Promise<never> {
      throw new ToolError(
        "tool.runtime-only",
        `'${declared.name}' runs in the Nylorun Runtime. Connect the agent to a Runtime to use it.`
      );
    },
  }) as ToolDefinition;
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
  if (manifest.metadata !== undefined) assertJson(manifest.metadata, "metadata");
  return deepFreeze(JSON.parse(JSON.stringify(manifest)) as AgentManifest);
}
