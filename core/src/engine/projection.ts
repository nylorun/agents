/**
 * What our engine adds to each agent of a session (protocol 15, ADR-100): the model-facing text
 * and tools that come with the session's Agent (its computer, `selfWake`), its memory, its loop
 * settings and the agent's skills, as the agent declares them (`engine`, `features.ts`). Our
 * harness offers exactly this (`@nylorun/harness`'s `engineToolsFor`), and `previewTurn` shows it.
 * One order keeps the prompt's prefix stable:
 *
 * - text: `skills` (the usage and the catalog); `sandbox`; `skill_folder`; `artifacts_save` and
 *   `outputs`; `artifacts_read`; `wake`; `triggers`; `memory`, then the agent's memory
 *   instructions; `plan`; `connection`;
 * - tools: the sandbox tools; the skill tools; `save_artifact`; `read_artifact`; `schedule_wake`;
 *   `triggers`; `memory`; `update_plan`; `request_connection`.
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
  TRIGGERS_TEXT,
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
  ASK_TOOL,
  DEFAULT_SANDBOX_TOOL_LIMITS,
  REQUEST_CONNECTION_TOOL,
  TRIGGERS_TOOL,
  UPDATE_PLAN_TOOL,
  artifactTools,
  askToolOf,
  connectionToolOf,
  memoryToolOf,
  planToolOf,
  sandboxTools,
  skillTools,
  triggersToolOf,
  wakeToolOf,
  type EngineTool,
  type SandboxToolLimits,
} from "./tools.js";
import { PLUGIN_NAMES, pluginOf, pluginSkills, runtimeToolName, type PluginName } from "../plugins/index.js";
import type { HarnessEnginePlugin } from "../types/manifest.js";

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
 * (`harness.loop.connections`). An agent whose own tools name one of them keeps its own.
 * `triggers` offers the `triggers` tool and its text (D83): true for the session's root agent when
 * the version declares `harness.engine.triggers` (`turn.start.agent.triggers`). What the agent
 * declares (`agent.engine`) decides the rest; a block it replaces is in its words.
 */
export function engineProjection(
  agent: Pick<AgentManifest, "skills" | "tools" | "engine">,
  runsOn: Pick<TurnAgent, "sandbox" | "selfWake"> | undefined,
  options: Pick<EngineToolLimits, "artifactPageBytes" | "sandboxTools">,
  memory?: EngineMemory,
  plan = false,
  connections = false,
  triggers = false,
  ask = false,
): EngineProjection {
  if (agent.engine?.plugins !== undefined)
    return pluginProjection(agent, agent.engine.plugins, runsOn, options, memory, plan, connections, triggers, ask);
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
  // The triggers the agent sets up itself (D83): the root agent's, when the version declares them.
  const own = (name: string) => (agent.tools ?? []).some((tool) => tool.name === name);
  const triggering = triggers && !own(TRIGGERS_TOOL);
  if (triggering) {
    use("triggers");
    instructions.push(text("triggers", TRIGGERS_TEXT));
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
      ...(triggering ? [triggersToolOf()] : []),
      ...(memory ? [memoryToolOf(writes)] : []),
      ...(planning ? [planToolOf()] : []),
      ...(connecting ? [connectionToolOf()] : []),
    ],
    instructions,
    blocks,
    features,
  };
}

/** The first line of server `nylorun`'s text (ADR-105). */
export const RUNTIME_SERVER_HEADING =
  "# Server nylorun\nThe Runtime's own tools, from the plugins this agent declares. Their names begin with nylorun__.";

/** A sandbox section's network sentence: the hosts the runtime allows, or the policy note. */
function networkSentence(hosts: readonly string[] | undefined): string {
  if (hosts === undefined || hosts.length === 0)
    return "Network egress is limited by policy; a failed download usually means the host is not allowed.";
  return `It can reach only these hosts: ${hosts.join(", ")}. A download from any other host fails.`;
}

/**
 * Our engine's tools and text for an agent that declares the Runtime's plugins (`agent-folder/3`,
 * ADR-105). The same tools as without plugins, with the same effects, named `nylorun__<tool>` for
 * the model; the Runtime's words are one text, server `nylorun`, built from the declared plugins'
 * sections in their order; their skills join the agent's own. `outputs`, the skills' usage and
 * catalog, and the skills' folder note stay our engine's blocks.
 */
function pluginProjection(
  agent: Pick<AgentManifest, "skills" | "tools" | "engine">,
  declared: readonly HarnessEnginePlugin[],
  runsOn: Pick<TurnAgent, "sandbox" | "selfWake"> | undefined,
  options: Pick<EngineToolLimits, "artifactPageBytes" | "sandboxTools">,
  memory: EngineMemory | undefined,
  plan: boolean,
  connections: boolean,
  triggers: boolean,
  ask: boolean,
): EngineProjection {
  const names = PLUGIN_NAMES.filter((name) => declared.some((plugin) => plugin.name === name));
  const on = (plugin: PluginName, tool: string) => declared.some((item) => item.name === plugin && item.tools.includes(tool));
  const own = (name: string) => (agent.tools ?? []).some((tool) => tool.name === name);
  const folderSkills = Object.values(agent.skills ?? {});
  const extra = pluginSkills(names).filter((skill) => !folderSkills.some((item) => item.name === skill.name));
  const catalog = [...folderSkills.map(({ name, description }) => ({ name, description })), ...extra.map(({ name, description }) => ({ name, description }))];
  const workspace = runsOn?.sandbox?.workspace;
  const features = engineFeaturesOf(agent.engine, { computer: workspace !== undefined });
  const sandbox = features.sandbox.filter((tool) => on("nylorun-sandbox", tool));
  const sandboxed = sandbox.length > 0;
  const readArtifacts = features.artifactsRead && on("nylorun-artifacts", "read_artifact");
  const saveArtifacts = features.artifactsSave && on("nylorun-artifacts", "save_artifact");
  const triggering = triggers && on("nylorun-triggers", "triggers") && !own(TRIGGERS_TOOL);
  const remembering = memory !== undefined && (memory.root === false || on("nylorun-memory", "memory"));
  const writes = memory !== undefined && memory.root && memory.access === "read_write";
  const planning = plan && on("nylorun-plan", UPDATE_PLAN_TOOL) && !own(UPDATE_PLAN_TOOL);
  const asking = ask && on("nylorun-interactions", ASK_TOOL) && !own(ASK_TOOL);
  const connecting = connections && on("nylorun-interactions", REQUEST_CONNECTION_TOOL) && !own(REQUEST_CONNECTION_TOOL);

  const instructions: string[] = [];
  const blocks: EngineBlockUse[] = [];
  const use = (name: EngineBlockName) => blocks.push({ name, version: ENGINE_BLOCK_VERSIONS[name] });
  if (catalog.length > 0) {
    use("skills");
    instructions.push(SKILLS_USAGE, formatSkillCatalog(catalog));
  }
  if (sandboxed && folderSkills.length > 0) {
    use("skill_folder");
    instructions.push(skillFolderNote(folderSkills));
  }
  if (features.outputs) {
    use("outputs");
    instructions.push(saveArtifacts ? OUTPUTS_AFTER_SAVE_TEXT : OUTPUTS_TEXT);
  }
  // Server nylorun: the declared plugins' sections, in plugin order.
  const text = (plugin: PluginName, section: string) => pluginOf(plugin).instructions[section];
  const sections: string[] = [];
  if (remembering) sections.push(text("nylorun-memory", writes ? "memory" : "memory.view")!);
  if (triggering) sections.push(text("nylorun-triggers", "triggers")!);
  if (planning) sections.push(text("nylorun-plan", "update_plan")!);
  if (asking || connecting)
    sections.push([text("nylorun-interactions", "_")!, ...(asking ? [text("nylorun-interactions", "ask")!] : []), ...(connecting ? [text("nylorun-interactions", "request_connection")!] : [])].join("\n"));
  if (readArtifacts || saveArtifacts)
    sections.push([text("nylorun-artifacts", "_")!, ...(saveArtifacts ? [text("nylorun-artifacts", "save_artifact")!] : []), ...(readArtifacts ? [text("nylorun-artifacts", "read_artifact")!] : [])].join("\n"));
  if (sandboxed) {
    const hosts = declared.find((plugin) => plugin.name === "nylorun-sandbox")?.hosts;
    sections.push(
      text("nylorun-sandbox", "_")!
        .replace("{workspace}", workspace!)
        .replace("{tools}", sandbox.map(runtimeToolName).join(", "))
        .replace("{network}", networkSentence(hosts)),
    );
  }
  if (sections.length > 0) instructions.push([RUNTIME_SERVER_HEADING, ...sections].join("\n\n"));

  const named = (tool: EngineTool): EngineTool => ({ ...tool, name: runtimeToolName(tool.name), effectName: tool.name });
  const skillManifests = [
    ...folderSkills,
    ...extra.map((skill) => ({ name: skill.name, description: skill.description, files: { "SKILL.md": "sha256:" + "0".repeat(64) } })),
  ];
  return {
    tools: [
      ...(sandboxed ? sandboxTools(options.sandboxTools, workspace!, sandbox).map(named) : []),
      ...skillTools(skillManifests),
      ...artifactTools({ read: readArtifacts, save: saveArtifacts, sandboxed }, { pageBytes: options.artifactPageBytes }).map(named),
      ...(triggering ? [named(triggersToolOf())] : []),
      ...(remembering ? [named(memoryToolOf(writes))] : []),
      ...(planning ? [named(planToolOf())] : []),
      ...(asking ? [named(askToolOf())] : []),
      ...(connecting ? [named(connectionToolOf())] : []),
    ],
    instructions,
    blocks,
    features: { ...features, sandbox, artifactsRead: readArtifacts, artifactsSave: saveArtifacts },
  };
}
