import { z } from "zod";
import type { CapabilityManifest, SkillManifest } from "../types/manifest.js";
import type { ToolDefinition } from "../types/tool.js";
import { SKILL_ENTRY } from "../utils/definition-files.js";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";

export const LOAD_SKILL_TOOL = "load_skill";
export const READ_SKILL_RESOURCE_TOOL = "read_skill_resource";
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  LOAD_SKILL_TOOL,
  READ_SKILL_RESOURCE_TOOL,
]);

const USAGE =
  "Load the full instructions for a named skill. Call this before following a skill.";

/**
 * Whether `toolName` is a skill tool the Runtime serves: `load_skill` or `read_skill_resource`
 * declared by a capability that has skills (the first one, where the build attaches them). A
 * tool of that name elsewhere is the author's own.
 */
export function isSkillTool(
  capability: CapabilityManifest | undefined,
  toolName: string | undefined
): boolean {
  return (
    capability !== undefined &&
    toolName !== undefined &&
    SKILL_TOOL_NAMES.has(toolName) &&
    Object.keys(capability.skills ?? {}).length > 0 &&
    capability.tools?.some((item) => item.name === toolName) === true
  );
}

/**
 * Stub implementation for the developer process. The Runtime serves the skill tools from the
 * skill files uploaded with the agent; reaching this means the agent ran without a Runtime.
 */
async function runtimeOnly(): Promise<never> {
  throw new ToolError(
    "skills.runtime-only",
    "Skills are served by the Nylorun Runtime from the files uploaded with the agent. Connect the agent to a Runtime to use them."
  );
}

/**
 * `load_skill` for every skill of an agent, and `read_skill_resource` when a skill has files
 * besides `SKILL.md`. Their names and input schemas are part of the hashed manifest; the Runtime
 * runs them.
 */
export function createSkillTools(
  skills: ReadonlyMap<string, SkillManifest>
): readonly ToolDefinition[] {
  const names = [...skills.keys()].sort();
  const nameSchema =
    names.length === 1
      ? z.literal(names[0]!)
      : z.enum(names as [string, ...string[]]);
  const definitions: ToolDefinition[] = [
    tool({
      name: LOAD_SKILL_TOOL,
      description: USAGE,
      inputSchema: z.object({ name: nameSchema }),
      effects: "read",
      execute: runtimeOnly,
    }),
  ];
  const hasResources = [...skills.values()].some((skill) =>
    Object.keys(skill.files).some((path) => path !== SKILL_ENTRY)
  );
  if (hasResources)
    definitions.push(
      tool({
        name: READ_SKILL_RESOURCE_TOOL,
        description: "Read one text resource from a skill after load_skill.",
        inputSchema: z.object({
          name: nameSchema,
          path: z.string().min(1),
        }),
        effects: "read",
        execute: runtimeOnly,
      })
    );
  return definitions;
}
