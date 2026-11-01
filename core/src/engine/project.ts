/**
 * What our engine adds to each agent of a session (protocol 15, ADR-100): the model-facing text
 * and tools that come with the session's Agent (its computer, `selfWake`), its memory, its loop
 * settings and the agent's skills, as the agent declares them (`engine`, `features.ts`). Our
 * harness offers exactly this (`@nylorun/harness`'s `engineToolsFor`), and `previewTurn` shows it.
 * One order keeps the prompt's prefix stable:
 *
 * - text: `skills` (the usage and the catalog); `sandbox`; `skill_folder`; `artifacts_save` and
 *   `outputs`; `artifacts_read`; `wake`; `memory`, then the agent's memory instructions; `plan`;
 *   `connection`;
 * - tools: the sandbox tools; the skill tools; `save_artifact`; `read_artifact`; `schedule_wake`;
 *   `memory`; `update_plan`; `request_connection`.
 *
 * They come after the agent's own and before the session's MCP tools (`mcpToolSet`), and are
 * not hashed.
 */
import type { AgentManifest } from "../types/manifest.js";
import type { TurnAgent, TurnMemory } from "../harness-api/messages.js";
import {
  ARTIFACTS_READ_TEXT,
  ARTIFACTS_SAVE_TEXT,
  CONNECTION_TEXT,
  ENGINE_BLOCK_VERSIONS,
  MEMORY_DATA_RULE,
  MEMORY_READ_ONLY_DATA_RULE,
  OUTPUTS_AFTER_SAVE_TEXT,
  OUTPUTS_TEXT,
  PLAN_TEXT,
  SKILLS_USAGE,
  WAKE_TEXT,
  formatSkillCatalog,
  memoryRules,
  sandboxNote,
  skillFolderNote,
  type EngineBlockName,
  type EngineBlockUse,
} from "./blocks.js";
import { engineFeaturesOf, type EngineFeatures } from "./features.js";
import {
  DEFAULT_SANDBOX_TOOL_LIMITS,
  REQUEST_CONNECTION_TOOL,
  UPDATE_PLAN_TOOL,
  artifactTools,
  connectionToolOf,
  memoryToolOf,
  planToolOf,
  sandboxTools,
  skillTools,
  wakeToolOf,
  type EngineTool,
  type SandboxToolLimits,
} from "./tools.js";

/** The harness's configuration of our engine's own tools that their definitions name. */
export interface EngineToolLimits {
  /** The most bytes one `read_artifact` page holds, escaped as JSON. */
  readonly artifactPageBytes: number;
  /** The sandbox tools' limits: their schemas' maxima and defaults. */
  readonly sandboxTools: SandboxToolLimits;
  /** The most bytes of one skill file the skill tools read into the model's context. */
  readonly skillReadBytes: number;
}

/** The default of the harness's `artifactPageBytes` setting: one `read_artifact` page. */
export const DEFAULT_ARTIFACT_PAGE_BYTES = 32 * 1024;
/** The most bytes of one skill file the skill tools read into the model's context by default. */
export const DEFAULT_SKILL_READ_BYTES = 10 * 1024 * 1024;

/** Our engine's tool limits when the harness sets none. */
export const DEFAULT_ENGINE_TOOL_LIMITS: EngineToolLimits = Object.freeze({
  artifactPageBytes: DEFAULT_ARTIFACT_PAGE_BYTES,
  sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
  skillReadBytes: DEFAULT_SKILL_READ_BYTES,
});

/** The memory an agent of the session reads: the turn's, and whether the agent is the root. */
export type EngineMemory = Pick<TurnMemory, "access" | "instructions"> & {
  /** False for an agent used as a tool, which may only view memory. */
  readonly root: boolean;
  /** False when no index is pinned (`harness.memory.index: false`): the rules do not name one. */
  readonly index?: boolean;
};

/** Our engine's tools for one agent, the text the model reads with them, in order, and its blocks. */
export interface EngineProjection {
  readonly tools: readonly EngineTool[];
  readonly instructions: readonly string[];
  /** The text blocks the agent got, in order. */
  readonly blocks: readonly EngineBlockUse[];
  /** The features the agent got. */
  readonly features: EngineFeatures;
}

/**
 * Our engine's tools and text for `agent`, in a session on Agent `runsOn` (`turn.start.agent`)
 * with its memory (`turn.start.memory`). `memory.root` is false for an agent used as a tool,
 * which may only view memory. `plan` offers `update_plan`: true for the session's root agent when
 * the version sets `harness.loop.plan`; `connections` offers `request_connection` alike
 * (`harness.loop.connections`). An agent whose own tools name one of them keeps its own. What the
 * agent declares (`agent.engine`) decides the rest; a block it replaces is in its words.
 */
export function engineProjection(
  agent: Pick<AgentManifest, "skills" | "tools" | "engine">,
  runsOn: Pick<TurnAgent, "sandbox" | "selfWake"> | undefined,
  options: Pick<EngineToolLimits, "artifactPageBytes" | "sandboxTools">,
  memory?: EngineMemory,
  plan = false,
  connections = false,
): EngineProjection {
  const skills = Object.values(agent.skills ?? {});
  const workspace = runsOn?.sandbox?.workspace;
  const features = engineFeaturesOf(agent.engine, { computer: workspace !== undefined });
  const replaced = agent.engine?.instructions ?? {};
  const sandboxed = features.sandbox.length > 0;
  const instructions: string[] = [];
  const blocks: EngineBlockUse[] = [];
  const use = (name: EngineBlockName) => blocks.push({ name, version: ENGINE_BLOCK_VERSIONS[name] });
  const text = (name: EngineBlockName, engine: string) => replaced[name] ?? engine;
  if (skills.length > 0) {
    use("skills");
    instructions.push(text("skills", SKILLS_USAGE), formatSkillCatalog(skills.map(({ name, description }) => ({ name, description }))));
  }
  if (sandboxed) {
    use("sandbox");
    instructions.push(text("sandbox", sandboxNote(workspace!)));
    if (skills.length > 0) {
      use("skill_folder");
      const own = replaced.skill_folder;
      instructions.push(own === undefined ? skillFolderNote(skills) : `${own}\n${skillFolderNote(skills)}`);
    }
  }
  // The artifact notes: saving, the outputs folder, and reading.
  const saving = features.artifactsSave ? text("artifacts_save", ARTIFACTS_SAVE_TEXT) : undefined;
  const outputs = features.outputs ? text("outputs", saving === undefined ? OUTPUTS_TEXT : OUTPUTS_AFTER_SAVE_TEXT) : undefined;
  if (saving !== undefined) use("artifacts_save");
  if (outputs !== undefined) use("outputs");
  if (saving !== undefined || outputs !== undefined) instructions.push([saving, outputs].filter((item) => item !== undefined).join(" "));
  if (features.artifactsRead) {
    use("artifacts_read");
    instructions.push(text("artifacts_read", ARTIFACTS_READ_TEXT));
  }
  // A session that may book its own next turn (track T4, D77).
  const wake = runsOn?.selfWake === true;
  if (wake) {
    use("wake");
    instructions.push(text("wake", WAKE_TEXT));
  }
  // The Agent's memory (track T5, D72).
  const writes = memory !== undefined && memory.root && memory.access === "read_write";
  if (memory) {
    use("memory");
    const own = replaced.memory;
    // The rule that text from outside is data stays, whatever the folder's wording (ADR-100).
    const rules = own === undefined ? memoryRules(writes, memory.index !== false) : `${own}\n${writes ? MEMORY_DATA_RULE : MEMORY_READ_ONLY_DATA_RULE}`;
    instructions.push([rules, ...(memory.instructions ? [`Memory instructions for this agent:\n${memory.instructions}`] : [])].join("\n\n"));
  }
  // The agent's plan (A2A profile v2, `progress/v1`).
  const own = (name: string) => (agent.tools ?? []).some((tool) => tool.name === name);
  const planning = plan && !own(UPDATE_PLAN_TOOL);
  if (planning) {
    use("plan");
    instructions.push(text("plan", PLAN_TEXT));
  }
  // The apps the agent asks to have connected (A2A profile v2, `interactions/v1` kind `connection`).
  const connecting = connections && !own(REQUEST_CONNECTION_TOOL);
  if (connecting) {
    use("connection");
    instructions.push(text("connection", CONNECTION_TEXT));
  }
  return {
    tools: [
      ...(sandboxed ? sandboxTools(options.sandboxTools, workspace!, features.sandbox) : []),
      ...skillTools(skills),
      ...artifactTools(
        { read: features.artifactsRead, save: features.artifactsSave, sandboxed },
        { pageBytes: options.artifactPageBytes },
      ),
      ...(wake ? [wakeToolOf()] : []),
      ...(memory ? [memoryToolOf(writes)] : []),
      ...(planning ? [planToolOf()] : []),
      ...(connecting ? [connectionToolOf()] : []),
    ],
    instructions,
    blocks,
    features,
  };
}
