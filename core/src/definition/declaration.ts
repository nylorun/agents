import type { DefinitionPart } from "./bound.js";
import type { CapabilityInput } from "../types/middleware.js";
import type { ToolDefinition } from "../types/tool.js";
import type { SandboxManifest } from "../types/manifest.js";
import { delegateTool, isAgentItem } from "./delegate.js";
import { HarnessError } from "../errors.js";
import { REMOVED_CAPABILITY_FIELDS } from "./removed.js";

/** The definition part a declaration adds: its tools (agents become delegate tools) and text. */
export function compileDeclaration<Info>(declaration: CapabilityInput<Info>): DefinitionPart {
  for (const [field, message] of Object.entries(REMOVED_FIELDS))
    if ((declaration as Record<string, unknown>)[field] !== undefined)
      throw new HarnessError("configuration.invalid", `Capability '${declaration.id}': ${message}`);
  const tools = declaration.tools?.map((item) =>
    isAgentItem(item) ? delegateTool(item) : (item as ToolDefinition)
  );
  const sandbox = (declaration as { sandbox?: SandboxManifest }).sandbox;
  return {
    id: declaration.id,
    ...(declaration.name === undefined ? {} : { name: declaration.name }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(declaration.instructions === undefined
      ? {}
      : { instructions: Object.freeze([...declaration.instructions]) }),
    ...(declaration.type === undefined ? {} : { manifestType: declaration.type }),
    ...(declaration.metadata === undefined ? {} : { metadata: declaration.metadata }),
    ...(declaration.skills === undefined || Object.keys(declaration.skills).length === 0
      ? {}
      : { skills: declaration.skills }),
    ...(declaration.skillFiles === undefined || Object.keys(declaration.skillFiles).length === 0
      ? {}
      : { skillFiles: declaration.skillFiles }),
    ...(declaration.mcpServers === undefined || Object.keys(declaration.mcpServers).length === 0
      ? {}
      : { mcpServers: declaration.mcpServers }),
    // Definitions declare no sandbox; carry one through so the build can refuse it by name.
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

/** Fields a part no longer takes, and why. */
const REMOVED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  before: REMOVED_CAPABILITY_FIELDS.hooks!,
  after: REMOVED_CAPABILITY_FIELDS.hooks!,
  middleware: "step middleware was removed: an agent is its manifest alone (see MIGRATION.md)",
  model: REMOVED_CAPABILITY_FIELDS.model!,
});
