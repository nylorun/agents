import { FlowBuilder } from "./spec.js";
import type { Flow } from "./types.js";

export { FlowBuilder, isFlowBuilder } from "./spec.js";
export { compileAgentFlow } from "./compile.js";
export type * from "./types.js";

/**
 * A sequence with no id, for a switch case, parallel branch, map item or loop body
 * that is more than one step: `flow().step(planner).map(implementer)`.
 */
export function flow<In = any>(): Flow<In> {
  return new FlowBuilder() as unknown as Flow<In>;
}
