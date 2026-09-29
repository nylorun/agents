import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { WorkflowNode } from "../../types/workflow.js";
import {
  assertValidPathPart,
  diagnostic,
  fail,
  siblingUniquenessDiagnostics,
} from "./diagnostics.js";
import { emptyAccumulator, finishWorkflow, mergeChild } from "./build.js";
import {
  remapNodeKeys,
  resolveChild,
  runnableId,
  type WorkflowRunnable,
} from "./runnable.js";
import type { ChildRef, Slot, SlotInputArgs } from "./slot.js";
import { isSlot } from "./slot.js";
import type { BuiltWorkflow, OutputOf } from "./types.js";

export type ChainStep = ChildRef;

type StepId<S> = S extends Slot<infer R, any, any, any>
  ? S extends { readonly id: infer I extends string }
    ? I
    : RunnableId<R>
  : RunnableId<S>;

type RunnableId<R> = R extends { readonly id: infer I extends string }
  ? I
  : R extends { readonly name: infer N extends string }
    ? N
    : string;

type StepOutput<S> = S extends Slot<infer R, any, any, any> ? OutputOf<R> : OutputOf<S>;

/** Results object available to step K (earlier step outputs only). */
export type ResultsBefore<Steps extends readonly ChainStep[], K extends number> = {
  readonly [I in keyof Steps as I extends `${infer N extends number}`
    ? N extends K
      ? never
      : `${N}` extends `${infer M extends number}`
        ? M extends number
          ? M extends K
            ? never
            : Compare<M, K> extends true
              ? StepId<Steps[M] & ChainStep>
              : never
          : never
        : never
      : never]: StepOutput<Steps[I & keyof Steps] & ChainStep>;
};

/** `true` when A < B (both number literals). Simplified: use a recursive counter for small tuples. */
type Compare<A extends number, B extends number> = A extends B
  ? false
  : LessThan<[...TupleOf<A>], [...TupleOf<B>]>;

type TupleOf<N extends number, Acc extends unknown[] = []> = Acc["length"] extends N
  ? Acc
  : TupleOf<N, [...Acc, unknown]>;

type LessThan<A extends unknown[], B extends unknown[]> = A["length"] extends B["length"]
  ? false
  : A extends [...B, ...unknown[]]
    ? false
    : B extends [...A, ...unknown[]]
      ? true
      : false;

/** Typed results accumulating through a steps tuple. */
export type ChainResults<Steps extends readonly ChainStep[]> = {
  readonly [I in keyof Steps as StepId<Steps[I & keyof Steps] & ChainStep>]: StepOutput<
    Steps[I & keyof Steps] & ChainStep
  >;
};

export type LastOutput<Steps extends readonly ChainStep[]> = Steps extends readonly [
  ...infer _Rest,
  infer Last,
]
  ? StepOutput<Last & ChainStep>
  : JsonValue;

export interface ChainOptions<
  Steps extends readonly [ChainStep, ...ChainStep[]] = readonly [ChainStep, ...ChainStep[]],
  In = JsonValue,
  Out = LastOutput<Steps>,
> {
  readonly id: string;
  readonly steps: Steps;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

/**
 * Run steps in order. Each step's output is the next step's input unless a slot
 * reshapes it. `results` exposes earlier step outputs to later slots (chain.md).
 */
export function Chain<
  const Steps extends readonly [ChainStep, ...ChainStep[]],
  In = JsonValue,
>(options: ChainOptions<Steps, In>): BuiltWorkflow<In, LastOutput<Steps>> {
  const { id, steps } = options;
  if (!id) fail([diagnostic("chain.missing-id", "Chain requires id")]);
  assertValidPathPart(id, "Chain id");
  if (!steps || steps.length === 0)
    fail([diagnostic("chain.empty-steps", "Chain steps must be non-empty")]);

  const ids = steps.map((step) => runnableId(step as ChildRef));
  const dupes = siblingUniquenessDiagnostics(ids, "Chain step");
  if (dupes.length) fail(dupes);

  const acc = emptyAccumulator();
  const stepNodes: WorkflowNode[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const resolved = resolveChild(step as ChildRef);
    assertValidPathPart(resolved.id, "Chain step id");
    const stepPath = `${id}/${resolved.id}`;
    mergeChild(acc, {
      agents: resolved.agents,
      nodes: remapNodeKeys(resolved.nodes, resolved.id, stepPath),
    });
    stepNodes.push(resolved.node);
  }

  return finishWorkflow<In, LastOutput<Steps>>({
    id,
    root: { chain: { id, steps: stepNodes } },
    acc,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
  });
}

/** Helper type: a slot whose `input` may only read known earlier result keys. */
export type ChainSlot<
  Run extends WorkflowRunnable,
  PrevResults extends Readonly<Record<string, JsonValue>>,
  Value = JsonValue,
  Input = JsonValue,
> = {
  readonly run: Run;
  readonly id?: string;
  readonly input?: (
    args: SlotInputArgs<Value, Input, PrevResults>,
  ) => JsonValue;
};
