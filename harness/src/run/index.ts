import type { AgentDefinition } from "../definition/agent-definition.js";
import { definitionFor, definitionFromBinding } from "../definition/agent-definition.js";
import { checkCompatibility } from "../definition/compatibility.js";
import { bindingFromAgent as authoringBindingFromAgent, agentFrom } from "@nylorun/core/define";
import type { Implementations } from "@nylorun/core/define";
import type { AgentBinding, BuiltAgent } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";
import type { ExecutionState, RunOptions, RunResult } from "../types/execution.js";
import { execute } from "../loop/run.js";
import { createExecutionState, validateExecutionState } from "../loop/state.js";
import { initializeExecutionState } from "../loop/initial-state.js";

export interface RunBinding<Info = unknown> {
  readonly manifest: AgentManifest;
  readonly implementations: Implementations<Info>;
  /** Optional authoring binding preserves live schemas and executable snapshots. */
  readonly authoring?: AgentBinding;
}

export interface BoundRunOptions<Info = unknown> extends RunOptions<Info> {
  readonly binding: RunBinding<Info>;
}

/**
 * Run the model/tool loop from a definition binding + optional checkpoint.
 * This is the public execution surface Runtime (and tests) should call.
 */
export async function run<Info = unknown, Output = string>(
  options: BoundRunOptions<Info>,
): Promise<RunResult<Output>> {
  const definition = resolveDefinition(options.binding as RunBinding);
  if (options.state?.manifestHash) {
    const compatibility = checkCompatibility(definition.manifest, options.state);
    if (!compatibility.ok) throw compatibility.error;
  }
  const { binding: _, ...runOptions } = options;
  return execute(definition, runOptions) as Promise<RunResult<Output>>;
}

/** Create a fresh checkpoint bound to a manifest hash. */
export function createRunState(
  binding: RunBinding,
  options?: {
    readonly executionId?: string;
    readonly state?: import("@nylorun/core/define").JsonObject;
  },
): ExecutionState {
  const definition = resolveDefinition(binding);
  return initializeExecutionState(definition, options);
}

function resolveDefinition(binding: RunBinding): AgentDefinition {
  if (binding.authoring) return definitionFromBinding(binding.authoring);
  const agent = agentFrom(binding.manifest, binding.implementations);
  return definitionFor(agent);
}

/** Build a run binding from an explicitly authored agent. */
export function bindingFromAgent(agent: BuiltAgent): RunBinding {
  const authoring = authoringBindingFromAgent(agent);
  return { manifest: authoring.manifest, implementations: authoring.implementations, authoring };
}

export { checkCompatibility, createExecutionState, validateExecutionState, execute };

export type { Implementations, ExecutionState, RunResult, RunOptions };

export { createDurableCheckpoint, runDurable } from "./durable.js";
export { createFlowCheckpoint, resumeFlowCheckpoint, runFlowDurable } from "../flow/index.js";
export type {
  DurableCheckpoint,
  DurableSessionTool,
  HostEffect,
  EffectResolution,
  DurableHost,
  DurableResult,
} from "./durable.js";
export type { FlowCheckpoint, FlowResume } from "../flow/checkpoint.js";
export type { FlowDurableResult, FlowInteraction, FlowRunResult } from "../flow/types.js";
export type { ModelAdapter, ModelCandidate, ModelCall, ModelRequest } from "@nylorun/core/define";
