import { SANDBOX_TOOL_NAMES } from "./sandbox.js";

/** Stores a sandbox file, or inline text, as a file artifact of the session (F8.1). */
export const SAVE_ARTIFACT_TOOL = "save_artifact";
/** Reads an artifact of the session in pages (R2b C11). */
export const READ_ARTIFACT_TOOL = "read_artifact";
/** Loads a skill's `SKILL.md`. */
export const LOAD_SKILL_TOOL = "load_skill";
/** Reads one resource file of a skill. */
export const READ_SKILL_RESOURCE_TOOL = "read_skill_resource";
/** Finds deferred tools by a query (BM25 over their names and descriptions). */
export const TOOL_SEARCH_TOOL = "tool_search";
/** Runs a deferred tool by name, as a call of that tool. */
export const TOOL_CALL_TOOL = "tool_call";

/**
 * The tools the Runtime serves: the sandbox tools, the artifact tools, the skill tools and the
 * deferred-tool pair. An agent's own tool may not take one of these names, so a tool's name alone
 * says whose it is.
 */
export const RUNTIME_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SANDBOX_TOOL_NAMES,
  SAVE_ARTIFACT_TOOL,
  READ_ARTIFACT_TOOL,
  LOAD_SKILL_TOOL,
  READ_SKILL_RESOURCE_TOOL,
  TOOL_SEARCH_TOOL,
  TOOL_CALL_TOOL,
]);

export function isRuntimeToolName(name: string): boolean {
  return RUNTIME_TOOL_NAMES.has(name);
}
