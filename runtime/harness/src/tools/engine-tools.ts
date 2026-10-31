/**
 * What our engine adds to each agent of a session (protocol 15): the model-facing text and tools
 * that come with the session's Environment and the agent's skills. The Runtime states facts in
 * `turn.start` (the Environment, its sandbox's workspace, the agent's skills); our engine words
 * them and defines the tools, in one order, which keeps the prompt's prefix stable:
 *
 * - instructions: the skills' usage and catalog; the sandbox note; the skills' folder note;
 *   the artifact notes;
 * - tools: the six sandbox tools; the skill tools; `save_artifact`; `read_artifact`;
 *   `schedule_wake` when the session's version sets `runtime.selfWake` (track T4); `memory`
 *   when it sets `harness.memory` (track T5); and, for the root agent, `update_plan` when it sets
 *   `harness.loop.plan` and `request_connection` when it sets `harness.loop.connections` (A2A
 *   profile v2).
 *
 * They come after the agent's own and before the session's MCP tools (`mcpToolSet`), and are
 * not hashed.
 */
import type { AgentManifest } from "@nylorun/core/define";
import type { TurnAgent, TurnMemory } from "@nylorun/core/harness-api";
import type { DurableSessionTool } from "../run/durable.js";
import { artifactInstructions, artifactToolsFor } from "./artifacts.js";
import { sandboxInstructions, sandboxTools, type SandboxToolLimits } from "./sandbox.js";
import { skillCatalogText, skillFolderNote, skillTools } from "./skills.js";
import { wakeTool } from "./wake.js";
import { memoryTool } from "./memory.js";
import { planTool, UPDATE_PLAN_TOOL } from "./plan.js";
import { connectionTool, REQUEST_CONNECTION_TOOL } from "./connection.js";
import type { McpToolConfig } from "./mcp.js";
import type { ToolResultConfig } from "./results.js";
import type { OutputsConfig } from "./outputs.js";

/** The harness's configuration of our engine's own tools. */
export interface EngineToolOptions {
  /** The most bytes one `read_artifact` page holds, escaped as JSON. */
  readonly artifactPageBytes: number;
  /** The sandbox tools' limits: their schemas' maxima and defaults. */
  readonly sandboxTools: SandboxToolLimits;
  /** The most bytes of one skill file the skill tools read into the model's context. */
  readonly skillReadBytes: number;
  /** How our engine names and defers the session's MCP tools, and `tool_search`'s limits. */
  readonly mcpTools: McpToolConfig;
  /** How our engine shapes tool results to fit the record: inline caps, previews, step budget. */
  readonly toolResults: ToolResultConfig;
  /** Where our engine finds a turn's outputs folder, and the most bytes it saves of it. */
  readonly outputs: OutputsConfig;
}

/** Our engine's tools for one agent, and the text the model reads with them, in order. */
export interface EngineTools {
  readonly tools: readonly DurableSessionTool[];
  readonly instructions: readonly string[];
}

/**
 * Our engine's tools and text for `agent`, in a session on Agent `runsOn` (`turn.start.agent`)
 * with its memory (`turn.start.memory`). `memory.root` is false for an agent used as a tool,
 * which may only view memory. `plan` offers `update_plan`: true for the session's root agent when
 * the version sets `harness.loop.plan` (`turn.start.loop.plan`); `connections` offers
 * `request_connection` alike (`harness.loop.connections`). An agent whose own tools name one of
 * them keeps its own.
 */
export function engineToolsFor(
  agent: Pick<AgentManifest, "skills" | "tools">,
  runsOn: TurnAgent | undefined,
  options: Pick<EngineToolOptions, "artifactPageBytes" | "sandboxTools" | "skillReadBytes">,
  memory?: Pick<TurnMemory, "access" | "instructions"> & { readonly root: boolean },
  plan = false,
  connections = false,
): EngineTools {
  const skills = Object.values(agent.skills ?? {});
  const workspace = runsOn?.sandbox?.workspace;
  const sandboxed = workspace !== undefined;
  const instructions: string[] = [];
  if (skills.length > 0) instructions.push(...skillCatalogText(skills));
  if (sandboxed) {
    instructions.push(sandboxInstructions(workspace));
    if (skills.length > 0) instructions.push(skillFolderNote(skills));
  }
  instructions.push(...artifactInstructions(sandboxed));
  // A session that may book its own next turn (track T4, D77).
  const wake = runsOn?.selfWake === true ? wakeTool() : undefined;
  if (wake) instructions.push(wake.instructions);
  // The Agent's memory (track T5, D72).
  const remember = memory ? memoryTool(memory, memory.root) : undefined;
  if (remember) instructions.push(remember.instructions);
  // The agent's plan (A2A profile v2, `progress/v1`).
  const own = (name: string) => (agent.tools ?? []).some((tool) => tool.name === name);
  const planning = plan && !own(UPDATE_PLAN_TOOL) ? planTool() : undefined;
  if (planning) instructions.push(planning.instructions);
  // The apps the agent asks to have connected (A2A profile v2, `interactions/v1` kind `connection`).
  const connecting = connections && !own(REQUEST_CONNECTION_TOOL) ? connectionTool() : undefined;
  if (connecting) instructions.push(connecting.instructions);
  return {
    tools: [
      ...(sandboxed ? sandboxTools(options.sandboxTools, workspace) : []),
      ...skillTools(skills),
      ...artifactToolsFor(sandboxed, { pageBytes: options.artifactPageBytes }),
      ...(wake ? [wake.tool] : []),
      ...(remember ? [remember.tool] : []),
      ...(planning ? [planning.tool] : []),
      ...(connecting ? [connecting.tool] : []),
    ],
    instructions,
  };
}
