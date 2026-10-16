/**
 * Flow limits (`workflows.md` §13): the Tenant's Runtime limits `flowConcurrency`, `flowMapItems`
 * and `flowLoopIterations` (`PUT /v1/tenant/limits`), read where they are checked. Core holds a
 * flow turn to `flowConcurrency` when it dispatches effects; the flow engine checks the other two,
 * which a flow's `turn.start` carries (`flowLimitsOf`).
 */
import type { RuntimeLimits } from "@nylorun/core/contracts";

/** What a flow's `turn.start.options.flowLimits` carries to the flow engine. */
export interface FlowEngineLimits {
  readonly maxMapItems: number;
  readonly maxLoopIterations: number;
}

/** The flow engine's limits from the Tenant's Runtime limits. */
export function flowLimitsOf(limits: Pick<RuntimeLimits, "flowMapItems" | "flowLoopIterations">): FlowEngineLimits {
  return { maxMapItems: limits.flowMapItems, maxLoopIterations: limits.flowLoopIterations };
}

/** Further ready work waits when `active` reaches `flowConcurrency` (not an error). */
export function mayDispatchMore(activeCount: number, limits: Pick<RuntimeLimits, "flowConcurrency">): boolean {
  return activeCount < limits.flowConcurrency;
}
