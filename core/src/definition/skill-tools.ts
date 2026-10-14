import { z } from "zod";
import type { AgentManifest, SkillManifest } from "../types/manifest.js";
import type { ToolDefinition } from "../types/tool.js";
import { SKILL_ENTRY } from "../utils/definition-files.js";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";

import { LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL } from "../utils/runtime-tools.js";

export { LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL };
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  LOAD_SKILL_TOOL,
  READ_SKILL_RESOURCE_TOOL,
]);

const USAGE =
  "Load the full instructions for a named skill. Call this before following a skill.";

/**
 * Whether `toolName` is a skill tool the Runtime serves: `load_skill` or `read_skill_resource` in
 * the pinned manifest's `runtime.tools`, which the Runtime adds when the agent has skills.
 */
export function isSkillTool(manifest: AgentManifest | undefined, toolName: string | undefined): boolean {
  return (
    toolName !== undefined &&
    SKILL_TOOL_NAMES.has(toolName) &&
    manifest?.runtime?.tools?.some((item) => item.name === toolName) === true
  );
}

/** The text before the skill catalog: when to load a skill. */
export const SKILLS_USAGE =
  "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.";

/** The skills the model may load, by name and description. */
export function formatSkillCatalog(
  skills: readonly { readonly name: string; readonly description: string }[]
): string {
  const entries = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
