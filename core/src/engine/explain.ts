/**
 * What `nylorun check --explain` prints (ADR-100): each engine feature an agent of a compiled
 * folder gets, and the tools and text blocks it adds, from the same projection the harness runs
 * (`previewTurn`). MCP tools are not known offline, so tool search says only whether the agent's
 * MCP tools may be deferred.
 */
import type { AgentManifestV8 } from "../contracts.js";
import type { AgentManifest } from "../types/manifest.js";
import { SANDBOX_TOOL_NAMES } from "../utils/sandbox.js";
import { ENGINE_BLOCK_VERSIONS, type EngineBlockName } from "./blocks.js";
import { previewTurn, type AgentTurnPreview } from "./preview.js";
import {
  LOAD_SKILL_TOOL,
  MEMORY_TOOL,
  READ_SKILL_RESOURCE_TOOL,
  REQUEST_CONNECTION_TOOL,
  SCHEDULE_WAKE_TOOL,
  TOOL_CALL_TOOL,
  TRIGGERS_TOOL,
  TOOL_SEARCH_TOOL,
  UPDATE_PLAN_TOOL,
  ASK_TOOL,
} from "./tools.js";
import { runtimeToolOf } from "../plugins/index.js";
import { READ_ARTIFACT_TOOL, SAVE_ARTIFACT_TOOL } from "../utils/runtime-tools.js";
import { loopManifestOf } from "../definition/sections.js";

/** The engine features, in the order the harness adds them. */
export const ENGINE_FEATURES = [
  "skills",
  "sandbox",
  "artifacts.save",
  "outputs",
  "artifacts.read",
  "selfWake",
  "triggers",
  "memory",
  "plan",
  "connections",
  "toolSearch",
] as const;
export type EngineFeature = (typeof ENGINE_FEATURES)[number];

/** One feature of one agent: whether it is on, what declares it, and what it adds. */
export interface ExplainedFeature {
  readonly feature: EngineFeature;
  readonly on: boolean;
  /** The key that turns it on: `engine.sandbox`, `memory`, `skills/`… */
  readonly declaredBy: string;
  /** The tools it adds, in the model's order. */
  readonly tools: readonly string[];
  /** The text blocks it adds, as `name@version`. */
  readonly blocks: readonly string[];
  /** What else it does: the pinned memory index, the outputs folder saved, MCP deferral. */
  readonly note?: string;
}

/** One agent of the folder: the root, or a subagent by id. */
export interface ExplainedAgent {
  readonly agent: string;
  /** The agent declares its engine features (`agent-folder/2`). */
  readonly declared: boolean;
  readonly features: readonly ExplainedFeature[];
}

const TOOLS: Readonly<Record<EngineFeature, readonly string[]>> = {
  skills: [LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL],
  sandbox: SANDBOX_TOOL_NAMES,
  "artifacts.save": [SAVE_ARTIFACT_TOOL],
  outputs: [],
  "artifacts.read": [READ_ARTIFACT_TOOL],
  selfWake: [SCHEDULE_WAKE_TOOL],
  triggers: [TRIGGERS_TOOL],
  memory: [MEMORY_TOOL],
  plan: [UPDATE_PLAN_TOOL],
  connections: [REQUEST_CONNECTION_TOOL, ASK_TOOL],
  toolSearch: [TOOL_SEARCH_TOOL, TOOL_CALL_TOOL],
};
/** The Runtime plugin that declares each feature in an `agent-folder/3` folder (ADR-106). */
const PLUGIN_OF: Readonly<Partial<Record<EngineFeature, string>>> = {
  sandbox: "nylorun-sandbox",
  "artifacts.save": "nylorun-artifacts",
  "artifacts.read": "nylorun-artifacts",
  selfWake: "nylorun-triggers",
  triggers: "nylorun-triggers",
  memory: "nylorun-memory",
  plan: "nylorun-plan",
  connections: "nylorun-interactions",
};
const BLOCKS: Readonly<Record<EngineFeature, readonly EngineBlockName[]>> = {
  skills: ["skills", "skill_folder"],
  sandbox: ["sandbox"],
  "artifacts.save": ["artifacts_save"],
  outputs: ["outputs"],
  "artifacts.read": ["artifacts_read"],
  selfWake: ["wake"],
  triggers: ["triggers"],
  memory: ["memory"],
  plan: ["plan"],
  connections: ["connection"],
  toolSearch: ["tool_search"],
};

function explainOne(
  id: string,
  preview: AgentTurnPreview,
  facts: { readonly root: boolean; readonly pinned: boolean; readonly mcp: boolean; readonly plugins?: boolean },
): ExplainedAgent {
  const declared = preview.features.declared;
  const by = (feature: EngineFeature): string => {
    // agent-folder/3: the plugin that brings it (ADR-106), or skills/ and the plugins' skills.
    if (facts.plugins) return PLUGIN_OF[feature] ?? (feature === "skills" ? "skills/ and the plugins' skills" : `engine.${feature}`);
    switch (feature) {
      case "skills":
        return "skills/";
      case "memory":
        return "memory";
      case "plan":
        return "loop.plan";
      case "connections":
        return "loop.connections";
      case "selfWake":
        return "runtime.selfWake";
      case "triggers":
        return "engine.triggers";
      default:
        return declared ? `engine.${feature}` : "by default";
    }
  };
  const blocks = new Set(preview.blocks.map((block) => block.name));
  // A Runtime plugin's tool by its own name: nylorun__memory is memory (ADR-106).
  const tools = new Set(preview.engineTools.map((name) => runtimeToolOf(name) ?? name));
  const features = ENGINE_FEATURES.map((feature): ExplainedFeature => {
    const added = TOOLS[feature].filter((name) => tools.has(name));
    const text = BLOCKS[feature].filter((name) => blocks.has(name)).map((name) => `${name}@${ENGINE_BLOCK_VERSIONS[name]}`);
    let on = added.length > 0 || text.length > 0;
    let note: string | undefined;
    if (feature === "outputs" && on)
      note = facts.root
        ? "/workspace/outputs is saved as the session's outputs folder when a turn ends"
        : "what it writes to /workspace/outputs is saved when its parent's turn ends";
    if (feature === "memory" && on)
      note = !facts.root
        ? "view only: the root agent's memory"
        : facts.pinned
          ? "the memory index is pinned at the head of each session"
          : "no memory index is pinned (memory.index: false)";
    if (feature === "toolSearch") {
      on = preview.features.toolSearch;
      note = !facts.mcp
        ? "the agent has no MCP servers"
        : on
          ? "MCP tools are deferred behind tool_search and tool_call when their schemas pass the threshold"
          : "MCP tools are never deferred automatically; a server's own deferred still applies";
      return { feature, on, declaredBy: by(feature), tools: on && facts.mcp ? TOOLS.toolSearch : [], blocks: on && facts.mcp ? [`tool_search@${ENGINE_BLOCK_VERSIONS.tool_search}`] : [], note };
    }
    return { feature, on, declaredBy: by(feature), tools: added, blocks: text, ...(note === undefined ? {} : { note }) };
  });
  return { agent: facts.root ? id : `subagent ${id}`, declared, features };
}

/**
 * Each engine feature of the agent `manifest` describes (an agent manifest v8, as a folder
 * compiles), and of each subagent: on or off, what declares it, and the tools and text blocks it
 * adds. A flow is not explained: its agents are.
 */
export function explainEngine(manifest: AgentManifestV8): ExplainedAgent[] {
  if ("kind" in manifest.harness) return [];
  const preview = previewTurn(manifest);
  const loop = loopManifestOf(manifest) as AgentManifest;
  const mcpOf = (agent: AgentManifest) => Object.keys(agent.mcpServers ?? {}).length > 0;
  const plugins = manifest.harness.engine?.plugins !== undefined;
  const root = explainOne(manifest.name, preview, { root: true, pinned: preview.pinned.length > 0, mcp: mcpOf(loop), plugins });
  const subagents = (loop.tools ?? []).flatMap((tool) =>
    tool.agent && !("kind" in tool.agent) && preview.agents[tool.agent.id]
      ? [explainOne(tool.agent.id, preview.agents[tool.agent.id]!, { root: false, pinned: false, mcp: mcpOf(tool.agent), plugins })]
      : [],
  );
  return [root, ...subagents];
}
