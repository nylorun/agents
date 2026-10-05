import { HarnessError } from "@nylorun/core/define";
import { WorkflowManifestSchema, type WorkflowManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/define";
import type { DurableHost } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import { CHECKPOINT_VERSION, flowEngineVersionOf } from "../compatibility.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { createFlowContext, failureOf, settleInFlight, suspendedResult } from "./context.js";
import type { FlowOperatorLimits } from "./limits.js";
import { runNode, unwrapSlot } from "./node.js";
import { runLoop } from "./loop.js";
import { runFlowV2 } from "./v2.js";
import { FlowNodeError, type FlowDurableResult } from "./types.js";

/**
 * Deterministic flow interpreter for workflow manifests. v2 manifests run on the
 * `flow-2` engine (`./v2.ts`); v1 manifests on `flow-1`, one module per primitive.
 * Returns effects only (SD-I1).
 */
export async function runFlowDurable(options: {
  manifest: WorkflowManifest;
  checkpoint: FlowCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
  /** Operator ceilings (`maxMapItems`, `maxLoopIterations`). Host/Runtime supplies these. */
  limits?: Partial<FlowOperatorLimits> | null;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, host, signal, limits } = options;
  WorkflowManifestSchema.parse(manifest);
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.engineVersion !== flowEngineVersionOf(manifest) ||
    checkpoint.manifestHash !== hashManifest(manifest)
  )
    throw new HarnessError("execution.incompatible", "Incompatible flow checkpoint");

  if (manifest.workflowSchemaVersion === 2)
    return runFlowV2({ manifest, checkpoint, host, signal, limits });

  const root = manifest.root;

  // Root Loop keeps the dedicated entry (history / verify wiring).
  if ("loop" in root) return runLoop({ manifest, checkpoint, host, signal, limits });

  const ctx = createFlowContext({ manifest, checkpoint, host, signal, limits });
  const { part } = unwrapSlot(root);
  const rootPath = part;

  try {
    if (signal?.aborted)
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const output = await runNode(ctx, root, rootPath, checkpoint.input);
    return {
      status: "completed",
      checkpoint,
      result: { status: "completed", output },
    };
  } catch (error) {
    await settleInFlight(ctx);
    if (error instanceof HostSuspension) return suspendedResult(ctx);
    if (error instanceof FlowNodeError && error.failure.code === "cancelled")
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const failure = failureOf(error, rootPath);
    return {
      status: "failed",
      checkpoint,
      result: { status: "failed", error: failure },
      ...(ctx.cancelEffectIds.size > 0 ? { cancelEffectIds: [...ctx.cancelEffectIds] } : {}),
    };
  }
}
