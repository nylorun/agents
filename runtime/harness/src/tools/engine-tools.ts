/**
 * What our engine adds to each agent of a session (protocol 15): the model-facing text and tools
 * that come with the session's Environment and the agent's skills. The Runtime states facts in
 * `turn.start` (the Environment, its sandbox's workspace, the agent's skills); our engine words
 * them and defines the tools, in one order, which keeps the prompt's prefix stable:
 *
 * - instructions: the skills' usage and catalog; the sandbox note; the skills' folder note;
 *   the artifact notes;
 * - tools: the six sandbox tools; the skill tools; `save_artifact`; `read_artifact`.
 *
 * They come after the agent's own and before the session's MCP tools (`mcpToolSet`), and are
 * not hashed.
 */
import type { AgentManifest } from "@nylorun/core/define";
import type { TurnEnvironment } from "@nylorun/core/harness-api";
import type { DurableSessionTool } from "../run/durable.js";
import { artifactInstructions, artifactToolsFor } from "./artifacts.js";
import { sandboxInstructions, sandboxTools, type SandboxToolLimits } from "./sandbox.js";
import { skillCatalogText, skillFolderNote, skillTools } from "./skills.js";
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

/** Our engine's tools and text for `agent`, in a session in `environment`. */
export function engineToolsFor(
  agent: Pick<AgentManifest, "skills">,
  environment: TurnEnvironment | undefined,
  options: Pick<EngineToolOptions, "artifactPageBytes" | "sandboxTools" | "skillReadBytes">,
): EngineTools {
  const skills = Object.values(agent.skills ?? {});
  const workspace = environment?.sandbox?.workspace;
  const sandboxed = workspace !== undefined;
  const instructions: string[] = [];
  if (skills.length > 0) instructions.push(...skillCatalogText(skills));
  if (sandboxed) {
    instructions.push(sandboxInstructions(workspace));
    if (skills.length > 0) instructions.push(skillFolderNote(skills));
  }
  instructions.push(...artifactInstructions(sandboxed));
  return {
    tools: [
      ...(sandboxed ? sandboxTools(options.sandboxTools, workspace) : []),
      ...skillTools(skills),
      ...artifactToolsFor(sandboxed, { pageBytes: options.artifactPageBytes }),
    ],
    instructions,
  };
}
