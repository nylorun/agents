/**
 * The names of our engine's text blocks (ADR-100): each piece of text our engine adds to an
 * agent's system text is a named block with a version (`memory@1`). An `agent-folder/2` manifest
 * lists the blocks it gets, with their hashes (`harness.engine.blocks`), and may replace a
 * block's wording (`harness.engine.instructions.<block>`). Kept apart from the blocks' text so
 * the manifest schemas can name them without importing it.
 */
export const ENGINE_BLOCK_NAMES = Object.freeze([
  "skills",
  "sandbox",
  "skill_folder",
  "artifacts_save",
  "outputs",
  "artifacts_read",
  "wake",
  "memory",
  "plan",
  "connection",
  "tool_search",
] as const);
export type EngineBlockName = (typeof ENGINE_BLOCK_NAMES)[number];

export function isEngineBlockName(name: string): name is EngineBlockName {
  return (ENGINE_BLOCK_NAMES as readonly string[]).includes(name);
}

/** The folder format that declares every engine feature it uses. */
export const AGENT_FOLDER_V2 = "agent-folder/2";
