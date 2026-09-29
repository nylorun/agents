import { SANDBOX_INSTRUCTIONS, createSandboxTools } from "./sandbox-tools.js";
import { normalizedSchemasFor } from "./schema.js";
import { copyJsonObject } from "../utils/immutable.js";
import type { CapabilityManifest, SandboxManifest, ToolManifest } from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";

/** Id of the capability the Runtime adds to a session whose sandbox was chosen at open. */
export const SANDBOX_CAPABILITY_ID = "nylorun.sandbox";

/**
 * The capability manifest that gives a session its sandbox: the six built-in tools, the sandbox
 * instructions and the resolved spec. The Runtime adds it to a session's pinned manifest. Its
 * tools are projected the way the builder projects any tool.
 */
export function sandboxCapabilityManifest(spec: SandboxManifest): CapabilityManifest {
  const tools = createSandboxTools().map((tool): ToolManifest => {
    const schemas = normalizedSchemasFor(tool);
    return {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: schemas.inputSchema.jsonSchema,
      ...(schemas.outputSchema === undefined
        ? {}
        : { outputSchema: schemas.outputSchema.jsonSchema }),
    };
  });
  return {
    id: SANDBOX_CAPABILITY_ID,
    type: "agent",
    instructions: [SANDBOX_INSTRUCTIONS],
    tools,
    sandbox: copyJsonObject(spec as unknown as JsonObject, "sandbox") as SandboxManifest,
  };
}
