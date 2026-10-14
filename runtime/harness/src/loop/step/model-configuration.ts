import type { BoundToolDefinition } from "@nylorun/core/define";
import type { InternalModelConfigurationSnapshot } from "./describe.js";
import type {
  ModelConfigurationContributor,
  ModelConfigurationInstruction,
  ModelConfigurationMutationOptions,
  ModelConfigurationTool,
} from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import type { ToolDefinition } from "@nylorun/core/define";
import { bindTool } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";
import { SlotDraft, type SlotOwner } from "./slot-assembly.js";

/** Per-step model configuration draft, set from the definition's parts. It never persists past the call. */
export class ModelConfigurationDraft {
  #instructions = new SlotDraft<readonly string[]>();
  #tools = new SlotDraft<readonly BoundToolDefinition[]>();

  setInstructions(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    items: readonly string[],
    options?: ModelConfigurationMutationOptions,
  ): void {
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string"))
      throw new HarnessError(
        "configuration.invalid-instructions",
        "Model configuration instructions must be strings",
      );
    this.#instructions.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze([...items]),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "configuration.invalid-slot",
      invalidOrder: "configuration.invalid-order",
      invalidReason: "configuration.invalid-reason",
      label: "Model configuration",
    });
  }

  setTools(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    tools: readonly ToolDefinition[],
    options?: ModelConfigurationMutationOptions,
  ): void {
    if (!Array.isArray(tools))
      throw new HarnessError(
        "configuration.invalid-tools",
        "Model configuration tools must be an array",
      );
    this.#tools.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze(tools.map((tool) => bindTool(tool, { middlewareId, slot }))),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "configuration.invalid-slot",
      invalidOrder: "configuration.invalid-order",
      invalidReason: "configuration.invalid-reason",
      label: "Model configuration",
    });
  }

  snapshot(): InternalModelConfigurationSnapshot {
    const instructionSlots = this.#instructions.values();
    const toolSlots = this.#tools.values();
    const instructions = instructionSlots.flatMap((slot) =>
      slot.value.map((text) =>
        Object.freeze({
          text,
          contributor: contributor(slot.owner, slot.reason),
        }),
      ),
    );
    const sourcedTools = toolSlots.flatMap((slot) =>
      slot.value.map((tool) =>
        Object.freeze({ tool, contributor: contributor(slot.owner, slot.reason) }),
      ),
    );
    const seen = new Set<string>();
    const duplicate = new Set<string>();
    for (const item of sourcedTools) {
      if (seen.has(item.tool.name)) duplicate.add(item.tool.name);
      seen.add(item.tool.name);
    }
    if (duplicate.size)
      throw new HarnessError(
        "configuration.duplicate-tool-name",
        `Duplicate Tool '${[...duplicate].sort().join("', '")}'`,
      );
    const toolContracts = sourcedTools.map(({ tool, contributor: source }) =>
      toolContract(tool, source),
    );
    return Object.freeze({
      version: 1,
      instructions: Object.freeze(instructions),
      tools: Object.freeze(sourcedTools.map((item) => item.tool)),
      toolContracts: Object.freeze(toolContracts),
      contributors: Object.freeze([
        ...instructionSlots.map((slot) => contributor(slot.owner, slot.reason)),
        ...toolSlots.map((slot) => contributor(slot.owner, slot.reason)),
      ]),
    });
  }
}

function contributor(owner: SlotOwner, reason?: string): ModelConfigurationContributor {
  return Object.freeze({
    middlewareId: owner.middlewareId,
    slot: owner.slot,
    order: owner.order,
    ...(reason === undefined ? {} : { reason }),
  });
}

function providerTool(tool: BoundToolDefinition): object {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: copyJson(tool.inputSchema.jsonSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: copyJson(tool.outputSchema.jsonSchema) }),
  };
}

function toolContract(
  tool: BoundToolDefinition,
  source: ModelConfigurationContributor,
): ModelConfigurationTool {
  const value = providerTool(tool) as {
    name: string;
    description?: string;
    inputSchema: JsonObject;
    outputSchema?: JsonObject;
  };
  return Object.freeze({ ...value, contributor: source });
}
