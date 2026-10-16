/**
 * Flow ceilings for the engine (`workflows.md` §13): the Tenant's Runtime limits `flowMapItems`
 * and `flowLoopIterations`, which a flow's `turn.start.options.flowLimits` carries.
 */

import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { FlowNodeError } from "./types.js";

export type FlowOperatorLimits = {
  readonly maxMapItems: number;
  readonly maxLoopIterations: number;
};

/**
 * What the engine holds a flow to when its `turn.start` names no limits: the defaults of the
 * Runtime limits `flowMapItems` and `flowLoopIterations`, which a Tenant sets.
 */
export const FLOW_OPERATOR_DEFAULTS: FlowOperatorLimits = {
  maxMapItems: RUNTIME_LIMIT_DEFAULTS.flowMapItems,
  maxLoopIterations: RUNTIME_LIMIT_DEFAULTS.flowLoopIterations,
};

/** How many characters of a value a flow's failure message quotes, by default (engine config). */
export const DEFAULT_FLOW_VALUE_CHARS = 80;

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
