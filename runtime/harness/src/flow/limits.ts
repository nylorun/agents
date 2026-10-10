/**
 * Operator flow ceilings for the engine (`workflows.md` §13).
 * Host-side assert helpers live in the Runtime package; harness duplicates the
 * codes here so the engine never depends on Runtime.
 * Codes must stay identical: `map.too-many-items`, `loop.too-many-iterations`.
 */

import { FlowNodeError } from "./types.js";

export type FlowOperatorLimits = {
  readonly maxMapItems: number;
  readonly maxLoopIterations: number;
};

/** Same defaults as Runtime `FLOW_LIMIT_DEFAULTS` (item/iteration ceilings). */
export const FLOW_OPERATOR_DEFAULTS: FlowOperatorLimits = {
  maxMapItems: 1000,
  maxLoopIterations: 100,
};

export function resolveOperatorLimits(
  limits?: Partial<FlowOperatorLimits> | null,
): FlowOperatorLimits {
  return {
    maxMapItems: limits?.maxMapItems ?? FLOW_OPERATOR_DEFAULTS.maxMapItems,
    maxLoopIterations: limits?.maxLoopIterations ?? FLOW_OPERATOR_DEFAULTS.maxLoopIterations,
  };
}

/**
 * Map item ceiling. Exceeding raises `map.too-many-items` and nothing should start.
 */
export function assertMapItemCount(
  count: number,
  limits: Pick<FlowOperatorLimits, "maxMapItems">,
  path?: string,
): void {
  if (count > limits.maxMapItems)
    throw new FlowNodeError({
      code: "map.too-many-items",
      message: `Map produced ${count} items; maxMapItems is ${limits.maxMapItems}`,
      path,
    });
}

/**
 * Loop operator ceiling. Exceeding raises `loop.too-many-iterations`.
 * `n` is the 1-based iteration about to run.
 */
export function assertLoopIteration(
  n: number,
  limits: Pick<FlowOperatorLimits, "maxLoopIterations">,
  path?: string,
): void {
  if (n > limits.maxLoopIterations)
    throw new FlowNodeError({
      code: "loop.too-many-iterations",
      message: `Loop iteration ${n} exceeds maxLoopIterations ${limits.maxLoopIterations}`,
      path,
    });
}
