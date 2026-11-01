/**
 * What our engine adds to each agent of a session (protocol 15, ADR-100): the model-facing text
 * and tools that come with the session's Environment, its memory and loop settings, and the
 * agent's skills, as the agent declares them (`engine`, `agent-folder/2`) or, when it declares
 * nothing, every default of `agent-folder/1`. The Runtime states facts in `turn.start` (the
 * Environment, its sandbox's workspace, the memory, the agent's skills); our engine words them and
 * defines the tools, in one order, which keeps the prompt's prefix stable:
 *
 * - instructions: the skills' usage and catalog; the sandbox note; the skills' folder note;
 *   the artifact notes; the wake note; the memory rules; the plan and connection notes;
 * - tools: the sandbox tools; the skill tools; `save_artifact`; `read_artifact`;
 *   `schedule_wake` when the session's version sets `runtime.selfWake` (track T4); `memory`
 *   when it sets `harness.memory` (track T5); and, for the root agent, `update_plan` when it sets
 *   `harness.loop.plan` and `request_connection` when it sets `harness.loop.connections` (A2A
 *   profile v2).
 *
 * The code is `@nylorun/core/engine`'s (`engineProjection`), which the SDK's `previewTurn` runs
 * too. They come after the agent's own and before the session's MCP tools (`mcpToolSet`), and are
 * not hashed.
 */
import type { AgentManifest } from "@nylorun/core/define";
import type { TurnAgent } from "@nylorun/core/harness-api";
import {
  engineProjection,
  type EngineBlockUse,
  type EngineFeatures,
  type EngineMemory,
} from "@nylorun/core/engine";
import type { DurableSessionTool } from "../run/durable.js";
import type { SandboxToolLimits } from "./sandbox.js";
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
  /** The text blocks the agent got (ADR-100), in order. */
  readonly blocks?: readonly EngineBlockUse[];
  /** The engine features the agent got. */
  readonly features?: EngineFeatures;
}

/**
 * Our engine's tools and text for `agent`, in a session on Agent `runsOn` (`turn.start.agent`)
 * with its memory (`turn.start.memory`). `memory.root` is false for an agent used as a tool,
 * which may only view memory; `memory.index` false when no index is pinned. `plan` offers
 * `update_plan`: true for the session's root agent when the version sets `harness.loop.plan`
 * (`turn.start.loop.plan`); `connections` offers `request_connection` alike
 * (`harness.loop.connections`). An agent whose own tools name one of them keeps its own.
 */
export function engineToolsFor(
  agent: Pick<AgentManifest, "skills" | "tools" | "engine">,
  runsOn: TurnAgent | undefined,
  options: Pick<EngineToolOptions, "artifactPageBytes" | "sandboxTools" | "skillReadBytes">,
  memory?: EngineMemory,
  plan = false,
  connections = false,
): EngineTools {
  return engineProjection(agent, runsOn, options, memory, plan, connections);
}
