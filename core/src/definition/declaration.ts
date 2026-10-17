import type { DefinitionPart } from "./bound.js";
import type { PartDeclaration } from "../types/part.js";
import type { ToolDefinition } from "../types/tool.js";
import type { SandboxManifest } from "../types/manifest.js";
import { delegateTool, isAgentItem } from "./delegate.js";
import { HarnessError } from "../errors.js";
import { REMOVED_PART_FIELDS } from "./removed.js";

/** The definition part a declaration adds: its tools (agents become delegate tools) and text. */
export function compileDeclaration<Info>(declaration: PartDeclaration<Info>): DefinitionPart {
  for (const [field, message] of Object.entries(REMOVED_FIELDS))
    if ((declaration as unknown as Record<string, unknown>)[field] !== undefined)
      throw new HarnessError("configuration.invalid", `'${declaration.id}': ${message}`);
  const tools = declaration.tools?.map((item) =>
    isAgentItem(item) ? delegateTool(item) : (item as ToolDefinition)
  );
  const sandbox = (declaration as { sandbox?: SandboxManifest }).sandbox;
  return {
    id: declaration.id,
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(declaration.instructions === undefined
      ? {}
      : { instructions: Object.freeze([...declaration.instructions]) }),
    ...(declaration.skills === undefined || Object.keys(declaration.skills).length === 0
      ? {}
      : { skills: declaration.skills }),
    ...(declaration.skillFiles === undefined || Object.keys(declaration.skillFiles).length === 0
      ? {}
      : { skillFiles: declaration.skillFiles }),
    ...(declaration.skillSecrets === undefined || Object.keys(declaration.skillSecrets).length === 0
      ? {}
      : { skillSecrets: declaration.skillSecrets }),
    ...(declaration.mcpServers === undefined || Object.keys(declaration.mcpServers).length === 0
      ? {}
      : { mcpServers: declaration.mcpServers }),
    // Definitions declare no sandbox; carry one through so the build can refuse it by name.
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

/** Fields a part no longer takes, and why. */
const REMOVED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  before: REMOVED_PART_FIELDS.hooks!,
  after: REMOVED_PART_FIELDS.hooks!,
  middleware: "step middleware was removed: an agent is its manifest alone (see MIGRATION.md)",
  model: REMOVED_PART_FIELDS.model!,
});
