import type { BoundMiddleware, BoundToolDefinition } from "@nylorun/core/define";
import { bindTool } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import { canonical } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";

import type { ToolReference } from "../types/execution.js";

/** Definition-only lookup; no per-run selections or progress live here. */
export class ToolRegistry {
  private readonly tools = new Map<string, BoundToolDefinition>();
  private readonly owners = new WeakMap<object, string>();

  constructor(middleware: readonly BoundMiddleware[], snapshots?: readonly BoundToolDefinition[]) {
    for (const capability of middleware) {
      for (const tool of [...(capability.tools ?? []), ...(capability.sessionTools ?? [])]) {
        const key = JSON.stringify([capability.id, tool.name]);
        if (this.tools.has(key) || this.owners.has(tool))
          throw new HarnessError(
            "tool.invalid",
            `Duplicate registered tool '${tool.name}' in '${capability.id}'`,
          );
        this.tools.set(
          key,
          snapshots?.find((snapshot) => snapshot.source === tool) ??
            bindTool(tool, { middlewareId: capability.id, slot: capability.id }),
        );
        this.owners.set(tool, capability.id);
      }
    }
  }

  reference(tool: BoundToolDefinition): ToolReference {
    const capabilityId = this.owners.get(tool.source);
    if (!capabilityId)
      throw new HarnessError(
        "tool.unregistered",
        `Tool '${tool.name}' is not registered. Declare it in capability.tools.`,
      );
    const reference = copyJson({
      capabilityId,
      toolName: tool.source.name,
      descriptor: descriptor(tool),
    });
    this.restore(reference);
    return reference;
  }

  restore(reference: ToolReference): BoundToolDefinition {
    if ("familyId" in reference || "binding" in reference || "version" in reference)
      throw new HarnessError(
        "execution.incompatible",
        "Saved state uses a removed tool-family reference. Register an ordinary tool and start a new execution.",
      );
    const registered = this.tools.get(JSON.stringify([reference.capabilityId, reference.toolName]));
    if (!registered || canonical(descriptor(registered)) !== canonical(reference.descriptor))
      throw new HarnessError(
        "execution.incompatible",
        `Missing or changed registered tool '${reference.toolName}'`,
      );
    return registered;
  }
}

function descriptor(tool: BoundToolDefinition): ToolReference["descriptor"] {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema.jsonSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema.jsonSchema }),
  };
}
