import type { WorkflowBinding, WorkflowManifest } from "../../types/workflow.js";
import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";

/** A built flow agent: its workflow manifest and the code its tool nodes run. */
export interface BuiltWorkflow<In = JsonValue, Out = JsonValue> {
  readonly id: string;
  readonly manifest: WorkflowManifest;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
  toJSON(): WorkflowManifest;
  getBinding(): WorkflowBinding;
  /** Phantom type carriers for inference (never present at runtime). */
  readonly __input?: In;
  readonly __output?: Out;
}

export function isBuiltWorkflow(value: unknown): value is BuiltWorkflow {
  return (
    !!value &&
    typeof value === "object" &&
    "manifest" in value &&
    (value as { manifest?: { kind?: unknown } }).manifest?.kind === "workflow" &&
    typeof (value as BuiltWorkflow).getBinding === "function"
  );
}
