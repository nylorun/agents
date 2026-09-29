import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { WorkflowNode } from "../../types/workflow.js";
import {
  assertValidPathPart,
  diagnostic,
  fail,
} from "./diagnostics.js";
import { emptyAccumulator, finishWorkflow, mergeChild } from "./build.js";
import { remapNodeKeys, resolveChild, type WorkflowRunnable } from "./runnable.js";
import type { ChildRef } from "./slot.js";
import type { BuiltWorkflow, OutputOf } from "./types.js";

export type SwitchCases = Readonly<Record<string, ChildRef>>;

export type SwitchOn<In, Cases extends SwitchCases, HasDefault extends boolean> =
  HasDefault extends true
    ? (input: In) => string
    : (input: In) => Extract<keyof Cases, string>;

export type SwitchOutput<
  Cases extends SwitchCases,
  Default extends ChildRef | undefined,
> = OutputOf<Cases[keyof Cases]> | (Default extends ChildRef ? OutputOf<Default> : never);

export interface SwitchOptions<
  Cases extends SwitchCases = SwitchCases,
  In = JsonValue,
  Default extends ChildRef | undefined = undefined,
> {
  readonly id: string;
  readonly on: SwitchOn<In, Cases, Default extends ChildRef ? true : false>;
  readonly cases: Cases;
  readonly default?: Default;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

/**
 * Pick exactly one case by a pure `on` key (switch.md).
 * `default` is reserved and cannot be a case key.
 */
export function Switch<
  const Cases extends SwitchCases,
  In = JsonValue,
  Default extends ChildRef | undefined = undefined,
>(
  options: SwitchOptions<Cases, In, Default> & {
    readonly cases: Cases;
    readonly default?: Default;
  },
): BuiltWorkflow<In, SwitchOutput<Cases, Default>> {
  const { id, on, cases } = options;
  if (!id) fail([diagnostic("switch.missing-id", "Switch requires id")]);
  assertValidPathPart(id, "Switch id");
  if (typeof on !== "function")
    fail([diagnostic("switch.missing-on", "Switch requires on")]);
  if (!cases || Object.keys(cases).length === 0)
    fail([diagnostic("switch.empty-cases", "Switch cases must have at least one entry")]);

  const caseKeys = Object.keys(cases);
  for (const key of caseKeys) {
    if (key === "default")
      fail([
        diagnostic(
          "switch.reserved-default",
          "default is reserved and cannot be a case key",
        ),
      ]);
    assertValidPathPart(key, "Switch case key");
  }

  const acc = emptyAccumulator();
  const caseNodes: Record<string, WorkflowNode> = {};

  for (const key of caseKeys) {
    const resolved = resolveChild(cases[key]!);
    const casePath = `${id}/${key}`;
    mergeChild(acc, {
      agents: resolved.agents,
      nodes: remapNodeKeys(resolved.nodes, resolved.id, casePath),
    });
    caseNodes[key] = resolved.node;
  }

  let defaultNode: WorkflowNode | undefined;
  if (options.default !== undefined) {
    const resolved = resolveChild(options.default);
    const defaultPath = `${id}/default`;
    mergeChild(acc, {
      agents: resolved.agents,
      nodes: remapNodeKeys(resolved.nodes, resolved.id, defaultPath),
    });
    defaultNode = resolved.node;
  }

  acc.nodes[`${id}/on`] = {
    kind: "fn",
    fn: on as (...args: never[]) => unknown,
  };

  return finishWorkflow<In, SwitchOutput<Cases, Default>>({
    id,
    root: {
      switch: {
        id,
        on: { fn: true },
        cases: caseNodes,
        ...(defaultNode === undefined ? {} : { default: defaultNode }),
      },
    },
    acc,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
  });
}

/** @deprecated Prefer Switch — kept for documentation symmetry with decision tables. */
export type SwitchRunnable = WorkflowRunnable;
