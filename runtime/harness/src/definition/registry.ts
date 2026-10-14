import type { DefinitionPart, BoundToolDefinition } from "@nylorun/core/define";
import { bindTool } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import { canonical } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";

import type { ToolReference } from "../types/execution.js";

/** Definition-only lookup; no per-run selections or progress live here. */
export class ToolRegistry {
  private readonly tools = new Map<string, BoundToolDefinition>();
  private readonly registered = new WeakSet<object>();

  constructor(parts: readonly DefinitionPart[], snapshots?: readonly BoundToolDefinition[]) {
    for (const part of parts) {
      for (const tool of [...(part.tools ?? []), ...(part.sessionTools ?? [])]) {
        if (this.tools.has(tool.name) || this.registered.has(tool))
          throw new HarnessError("tool.invalid", `Duplicate registered tool '${tool.name}'`);
        this.tools.set(
          tool.name,
          snapshots?.find((snapshot) => snapshot.source === tool) ??
            bindTool(tool, { partId: part.id, slot: part.id }),
        );
        this.registered.add(tool);
      }
    }
  }

  reference(tool: BoundToolDefinition): ToolReference {
    if (!this.registered.has(tool.source))
      throw new HarnessError(
        "tool.unregistered",
        `Tool '${tool.name}' is not registered. Declare it with .tools().`,
      );
    const reference = copyJson({
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
    const registered = this.tools.get(reference.toolName);
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
