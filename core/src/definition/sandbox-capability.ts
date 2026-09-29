import { SANDBOX_INSTRUCTIONS, createSandboxTools } from "./sandbox-tools.js";
import { SANDBOX_WORKSPACE } from "../utils/sandbox.js";
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
export function sandboxCapabilityManifest(
  spec: SandboxManifest,
  options: {
    /** The workspace path the backend uses, named in the tools' text. Default `/workspace`. */
    readonly workspace?: string;
  } = {}
): CapabilityManifest {
  const workspace = options.workspace ?? SANDBOX_WORKSPACE;
  const text = (value: string) => value.replaceAll(SANDBOX_WORKSPACE, workspace);
  const tools = createSandboxTools().map((tool): ToolManifest => {
    const schemas = normalizedSchemasFor(tool);
    return {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: text(tool.description) }),
      inputSchema: schemas.inputSchema.jsonSchema,
      ...(schemas.outputSchema === undefined
        ? {}
        : { outputSchema: schemas.outputSchema.jsonSchema }),
    };
  });
  return {
    id: SANDBOX_CAPABILITY_ID,
    type: "agent",
    instructions: [text(SANDBOX_INSTRUCTIONS)],
    tools,
    sandbox: copyJsonObject(spec as unknown as JsonObject, "sandbox") as SandboxManifest,
  };
}
