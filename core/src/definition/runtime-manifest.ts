import { SANDBOX_INSTRUCTIONS, createSandboxTools } from "./sandbox-tools.js";
import { SANDBOX_WORKSPACE } from "../utils/sandbox.js";
import { SKILLS_MOUNT, skillFolderOf } from "../utils/definition-files.js";
import { normalizedSchemasFor } from "./schema.js";
import { createSkillTools, formatSkillCatalog, SKILLS_USAGE } from "./skill-tools.js";
import { copyJsonObject } from "../utils/immutable.js";
import type {
  AgentManifest,
  RuntimeManifest,
  SandboxManifest,
  ToolManifest,
} from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";

/** What the Runtime adds to a session's agent (`runtimeManifestFor`). */
export interface RuntimeManifestOptions {
  /** The session's sandbox: the six sandbox tools, their instructions and the spec. */
  readonly sandbox?: SandboxManifest;
  /** The workspace path the backend uses, named in the tools' text. Default `/workspace`. */
  readonly workspace?: string;
}

/**
 * The `runtime` block the Runtime pins on a session's agent: the sandbox and its tools, and the
 * skill tools with the skill catalog when the agent has skills. Its tools are projected the way
 * the builder projects any tool, so their schemas are part of the pinned manifest's hash; change
 * them deliberately. Undefined when the Runtime adds nothing. The artifact tools are our engine's
 * since protocol 15 (`@nylorun/harness`), not the Runtime's.
 */
export function runtimeManifestFor(
  manifest: Pick<AgentManifest, "skills">,
  options: RuntimeManifestOptions = {}
): RuntimeManifest | undefined {
  const workspace = options.workspace ?? SANDBOX_WORKSPACE;
  const text = (value: string) => value.replaceAll(SANDBOX_WORKSPACE, workspace);
  const skills = Object.values(manifest.skills ?? {});
  const instructions: string[] = [];
  const tools: ToolDefinition[] = [];
  if (skills.length > 0)
    instructions.push(
      SKILLS_USAGE,
      formatSkillCatalog(skills.map(({ name, description }) => ({ name, description })))
    );
  if (options.sandbox !== undefined) {
    instructions.push(text(SANDBOX_INSTRUCTIONS));
    if (skills.length > 0)
      instructions.push(
        `Each skill's files are in the sandbox, read-only, in its own folder under ${SKILLS_MOUNT}/ (${skills
          .map((skill) => `${skill.name}: ${skillFolderOf(skill)}/`)
          .join(", ")}): read them there and run their scripts with bash.`
      );
    tools.push(...createSandboxTools());
  }
  if (skills.length > 0)
    tools.push(...createSkillTools(new Map(skills.map((skill) => [skill.name, skill]))));
  if (instructions.length === 0 && tools.length === 0 && options.sandbox === undefined)
    return undefined;
  return {
    ...(options.sandbox === undefined
      ? {}
      : { sandbox: copyJsonObject(options.sandbox as unknown as JsonObject, "sandbox") as SandboxManifest }),
    ...(tools.length === 0 ? {} : { tools: tools.map((tool) => projectRuntimeTool(tool, text)) }),
    ...(instructions.length === 0 ? {} : { instructions }),
  };
}

/** The tool of `name` the Runtime added to `manifest`, if any. */
export function runtimeToolOf(
  manifest: AgentManifest | undefined,
  name: string | undefined
): ToolManifest | undefined {
  if (name === undefined) return undefined;
  return manifest?.runtime?.tools?.find((tool) => tool.name === name);
}

function projectRuntimeTool(tool: ToolDefinition, text: (value: string) => string): ToolManifest {
  const schemas = normalizedSchemasFor(tool);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: text(tool.description) }),
    inputSchema: schemas.inputSchema.jsonSchema,
    ...(schemas.outputSchema === undefined ? {} : { outputSchema: schemas.outputSchema.jsonSchema }),
  };
}
