export { checkCompatibility } from "./definition/compatibility.js";
export const CHECKPOINT_VERSION = 1;
export const ENGINE_VERSION = "hosted-4";
/** Flow engine version pinned on workflow checkpoints: workflow manifest v3 runs on `flow-3`. */
export const FLOW_ENGINE_VERSION = "flow-3";
export type FlowEngineVersion = typeof FLOW_ENGINE_VERSION;
