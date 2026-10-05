import type { BoundMiddleware } from "./bound.js";
import type {
  AgentManifest,
  CapabilityManifest,
  RuntimeManifest,
  ToolManifest,
} from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import { normalizedSchemasFor } from "./schema.js";
import { delegateOf } from "./delegate.js";
import { httpToolOf } from "./http-tool.js";

import { copyJsonObject, deepFreeze } from "../utils/immutable.js";

export function createManifest(input: {
  id: string;
  name?: string;
  description?: string;
  metadata?: JsonObject;
  outputSchema?: ToolSchemaSource;
  runtime?: RuntimeManifest;
  middleware: readonly BoundMiddleware[];
}): AgentManifest {
  const capabilities = input.middleware.map((item) => projectCapability(item));
  return deepFreeze({
    manifestSchemaVersion: 5 as const,
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
    capabilities,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  });
}

function projectCapability(item: BoundMiddleware): CapabilityManifest {
  const contributions = item.contributions;
  return {
    id: item.id,
    type: item.manifestType ?? "agent",
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(item.metadata, "metadata") }),
    ...(contributions?.instructions === undefined
      ? {}
      : { instructions: contributions.instructions }),
    ...(item.tools === undefined
      ? {}
      : { tools: item.tools.map((tool) => projectTool(tool)) }),
    ...(item.skills === undefined ? {} : { skills: item.skills }),
    ...(item.mcpServers === undefined ? {} : { mcpServers: item.mcpServers }),
    ...(item.sandbox === undefined
      ? {}
      : { sandbox: copyJsonObject(item.sandbox as unknown as JsonObject, "sandbox") }),
  };
}

function projectTool(
  tool: NonNullable<BoundMiddleware["tools"]>[number]
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
    ...(http?.approval === undefined ? {} : { approval: http.approval }),
  };
}
