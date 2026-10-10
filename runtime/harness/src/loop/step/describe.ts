import type { ModelConfigurationSnapshot } from "@nylorun/core/define";
import type { ToolDescriptor } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import type { BoundToolDefinition } from "@nylorun/core/define";

/** Executable configuration stays inside the invocation. */
export interface InternalModelConfigurationSnapshot extends Omit<
  ModelConfigurationSnapshot,
  "tools"
> {
  readonly tools: readonly BoundToolDefinition[];
}

export function describeTool(tool: BoundToolDefinition): ToolDescriptor {
  return copyJson({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    owner: tool.owner,
    inputSchema: { jsonSchema: tool.inputSchema.jsonSchema },
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: { jsonSchema: tool.outputSchema.jsonSchema } }),
  });
}

export function describeConfiguration(
  configuration: InternalModelConfigurationSnapshot,
): ModelConfigurationSnapshot {
  return copyJson({
    version: configuration.version,
    ...(configuration.model === undefined ? {} : { model: configuration.model }),
    instructions: configuration.instructions,
    tools: configuration.tools.map(describeTool),
    toolContracts: configuration.toolContracts,
    contributors: configuration.contributors,
  });
}
