import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { WorkflowNode } from "../../types/workflow.js";
import {
  assertValidPathPart,
  diagnostic,
  fail,
} from "./diagnostics.js";
import { emptyAccumulator, finishWorkflow, mergeChild } from "./build.js";
import { remapNodeKeys, resolveChild } from "./runnable.js";
import type { ChildRef } from "./slot.js";
import type { BuiltWorkflow, OutputOf } from "./types.js";

export type ParallelBranches = Readonly<Record<string, ChildRef>>;

export type ParallelOutput<Branches extends ParallelBranches> = {
  readonly [K in keyof Branches]: OutputOf<Branches[K]>;
};

export interface ParallelOptions<
  Branches extends ParallelBranches = ParallelBranches,
  In = JsonValue,
> {
  readonly id: string;
  readonly branches: Branches;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

/**
 * Run a fixed set of named branches concurrently on the same input (parallel.md).
 * Output is an object keyed by branch name in declaration order.
 */
export function Parallel<const Branches extends ParallelBranches, In = JsonValue>(
  options: ParallelOptions<Branches, In>,
): BuiltWorkflow<In, ParallelOutput<Branches>> {
  const { id, branches } = options;
  if (!id) fail([diagnostic("parallel.missing-id", "Parallel requires id")]);
  assertValidPathPart(id, "Parallel id");
  if (!branches || Object.keys(branches).length === 0)
    fail([
      diagnostic("parallel.empty-branches", "Parallel branches must have at least one entry"),
    ]);

  const acc = emptyAccumulator();
  const branchNodes: Record<string, WorkflowNode> = {};

  for (const name of Object.keys(branches)) {
    assertValidPathPart(name, "Parallel branch name");
    const resolved = resolveChild(branches[name]!);
    const branchPath = `${id}/${name}`;
    mergeChild(acc, {
      agents: resolved.agents,
      nodes: remapNodeKeys(resolved.nodes, resolved.id, branchPath),
    });
    branchNodes[name] = resolved.node;
  }

  return finishWorkflow<In, ParallelOutput<Branches>>({
    id,
    root: { parallel: { id, branches: branchNodes } },
    acc,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
  });
}
