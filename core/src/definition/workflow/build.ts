import type { AgentBinding } from "../binding.js";
import type { BuildDiagnostic, JsonValue } from "../../types/shared.js";
import type {
  WorkflowBinding,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import { diagnostic, fail } from "./diagnostics.js";
import type { BuiltWorkflow } from "./types.js";

export type BuildAccumulator = {
  readonly agents: Record<string, AgentBinding>;
  readonly nodes: Record<string, WorkflowNodeImplementation>;
};

export function emptyAccumulator(): BuildAccumulator {
  return { agents: {}, nodes: {} };
}

export function mergeChild(
  acc: BuildAccumulator,
  child: {
    readonly agents: Record<string, AgentBinding>;
    readonly nodes: Record<string, WorkflowNodeImplementation>;
  },
): void {
  Object.assign(acc.agents, child.agents);
  Object.assign(acc.nodes, child.nodes);
}

export type FinishOptions<In = JsonValue, Out = JsonValue> = {
  readonly id: string;
  readonly root: WorkflowNode;
  readonly acc: BuildAccumulator;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
  /** Extra diagnostics collected by the primitive. */
  readonly diagnostics?: readonly BuildDiagnostic[];
};

/**
 * Assemble a BuiltWorkflow: non-enumerable getBinding, manifest-only toJSON. A workflow
 * declares no sandbox: the session it runs in is opened with one (Sandboxes v3).
 */
export function finishWorkflow<In = JsonValue, Out = JsonValue>(
  options: FinishOptions<In, Out>,
): BuiltWorkflow<In, Out> {
  const diagnostics = [...(options.diagnostics ?? [])];
  if (diagnostics.length) fail(diagnostics);

  const manifest: WorkflowManifest = {
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: options.id,
    root: options.root,
  };

  const binding: WorkflowBinding = Object.freeze({
    manifest,
    nodes: Object.freeze({ ...options.acc.nodes }),
    agents: Object.freeze({ ...options.acc.agents }),
  });

  const built = {
    id: options.id,
    manifest,
    toJSON: () => manifest,
    ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  } as BuiltWorkflow<In, Out>;

  Object.defineProperty(built, "getBinding", {
    value: () => binding,
    enumerable: false,
  });

  return built;
}
