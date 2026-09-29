export { checkCompatibility } from "./definition/compatibility.js";
export const CHECKPOINT_VERSION = 1;
export const ENGINE_VERSION = "hosted-2";
/**
 * Flow engine version pinned on workflow checkpoints. Workflow manifest v2 runs on
 * `flow-2`; v1 manifests keep running on `flow-1`, so in-flight v1 runs finish as they began.
 */
export const FLOW_ENGINE_VERSION = "flow-2";
export const FLOW_ENGINE_VERSION_V1 = "flow-1";
export type FlowEngineVersion = typeof FLOW_ENGINE_VERSION | typeof FLOW_ENGINE_VERSION_V1;

/** The engine a workflow manifest runs on. */
export function flowEngineVersionOf(manifest: {
  readonly workflowSchemaVersion: number;
}): FlowEngineVersion {
  return manifest.workflowSchemaVersion === 2 ? FLOW_ENGINE_VERSION : FLOW_ENGINE_VERSION_V1;
}
