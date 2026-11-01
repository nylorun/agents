/**
 * What one agent gets of our engine's features (ADR-100), from what it declares and the facts of
 * its session. An agent that declares nothing (`agent-folder/1`, an SDK-built agent) gets every
 * default: the six sandbox tools with a computer, `read_artifact`, `save_artifact` and the
 * outputs folder with a computer, and tool search. One that declares `engine` gets only what it
 * names, each part that needs a computer only with one.
 */
import { SANDBOX_TOOL_NAMES, type SandboxToolName } from "../utils/sandbox.js";
import type { HarnessEngine } from "../types/manifest.js";

/** Whether an agent declares its engine features (`agent-folder/2`): then nothing is a default. */
export function declaresEngine(engine: HarnessEngine | undefined): engine is HarnessEngine {
  return engine !== undefined;
}

/** The engine features one agent gets in a session. */
export interface EngineFeatures {
  /** The agent declares them (`agent-folder/2`). */
  readonly declared: boolean;
  /** The sandbox tools offered, in our order. */
  readonly sandbox: readonly SandboxToolName[];
  readonly artifactsRead: boolean;
  readonly artifactsSave: boolean;
  /** The outputs folder is saved when a turn ends. */
  readonly outputs: boolean;
  /** MCP tools may be deferred behind `tool_search` past the threshold. */
  readonly toolSearch: boolean;
}

/** What an agent with `engine` gets in a session with (`computer`) or without a computer. */
export function engineFeaturesOf(engine: HarnessEngine | undefined, facts: { readonly computer: boolean }): EngineFeatures {
  const { computer } = facts;
  if (!declaresEngine(engine))
    return {
      declared: false,
      sandbox: computer ? SANDBOX_TOOL_NAMES : [],
      artifactsRead: true,
      artifactsSave: computer,
      outputs: computer,
      toolSearch: true,
    };
  const wanted = new Set(engine.sandbox ?? []);
  return {
    declared: true,
    sandbox: computer ? SANDBOX_TOOL_NAMES.filter((name) => wanted.has(name)) : [],
    artifactsRead: engine.artifacts?.read === true,
    artifactsSave: computer && engine.artifacts?.save === true,
    outputs: computer && engine.outputs === true,
    toolSearch: engine.toolSearch === true,
  };
}
