import type { DefinitionPart } from "./bound.js";
import type {
  AgentManifest,
  AgentRequirements,
  McpServerManifest,
  SkillManifest,
  ToolManifest,
} from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import { normalizedSchemasFor } from "./schema.js";
import { delegateOf } from "./delegate.js";
import { httpToolOf } from "./http-tool.js";

import { copyJsonObject, deepFreeze } from "../utils/immutable.js";

/**
 * The id of the part an agent rebuilt from its manifest gets for what one run adds to it: the
 * session's tools and the text that goes with them (`agentFrom` `sessionTools`). Not hashed.
 */
export const SESSION_PART_ID = "session";

/**
 * The agent's manifest (v7): its parts merged in order, the instructions and tools concatenated,
 * the skills and servers keyed by name. The session part is not projected.
 */
export function createManifest(input: {
  id: string;
  name?: string;
  description?: string;
  metadata?: JsonObject;
  outputSchema?: ToolSchemaSource;
  requires?: AgentRequirements;
  parts: readonly DefinitionPart[];
}): AgentManifest {
  const authored = input.parts.filter((part) => part.id !== SESSION_PART_ID);
  const instructions = authored.flatMap((part) => part.instructions ?? []);
  const tools = authored.flatMap((part) => (part.tools ?? []).map((tool) => projectTool(tool)));
  const skills: Record<string, SkillManifest> = {};
  const mcpServers: Record<string, McpServerManifest> = {};
  for (const part of authored) {
    Object.assign(skills, part.skills ?? {});
    Object.assign(mcpServers, part.mcpServers ?? {});
  }
  return deepFreeze({
    manifestSchemaVersion: 7,
    id: input.id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(input.metadata, "metadata") }),
    ...(input.outputSchema === undefined
      ? {}
      : {
          outputSchema: bindOutputContract(input.outputSchema).schema
            .jsonSchema,
        }),
    ...(instructions.length === 0 ? {} : { instructions }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(Object.keys(skills).length === 0 ? {} : { skills }),
    ...(Object.keys(mcpServers).length === 0 ? {} : { mcpServers }),
    ...(input.requires === undefined ? {} : { requires: copyRequirements(input.requires) }),
  });
}

/** `requires` as plain data, its secret names sorted and each once. */
function copyRequirements(requires: AgentRequirements): AgentRequirements {
  return {
    ...(requires.sandbox === undefined ? {} : { sandbox: requires.sandbox }),
    ...(requires.secrets === undefined ? {} : { secrets: [...new Set(requires.secrets)].sort() }),
  };
}

function projectTool(
  tool: NonNullable<DefinitionPart["tools"]>[number]
): ToolManifest {
  const schemas = normalizedSchemasFor(tool);
  const delegate = delegateOf(tool);
  const http = httpToolOf(tool);
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: schemas.inputSchema.jsonSchema,
    ...(schemas.outputSchema === undefined
      ? {}
      : { outputSchema: schemas.outputSchema.jsonSchema }),
    ...(delegate === undefined ? {} : { agent: delegate.manifest }),
    ...(http === undefined ? {} : { http: { ...http.http } }),
    // A pinned manifest's, from before R5 step 2: identity only.
    ...(http?.approval === undefined ? {} : { approval: http.approval }),
  };
}
