import { HarnessError } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";
import type { ExecutionState } from "../types/execution.js";
import { hashManifest } from "@nylorun/core/define";

export type CompatibilityResult =
  { readonly ok: true } | { readonly ok: false; readonly error: HarnessError };

/** Fail loud when a checkpoint was bound to a different definition. */
export function checkCompatibility(
  manifest: AgentManifest,
  state: ExecutionState,
): CompatibilityResult {
  const expected = hashManifest(manifest);
  if (state.manifestHash && state.manifestHash !== expected) {
    return {
      ok: false,
      error: new HarnessError(
        "execution.incompatible",
        "Saved state manifestHash does not match the supplied agent manifest",
        {
          details: {
            expected: expected.slice(0, 12),
            actual: state.manifestHash.slice(0, 12),
          },
        },
      ),
    };
  }
  if (state.agentId !== manifest.id) {
    return {
      ok: false,
      error: new HarnessError(
        "execution.incompatible",
        "Saved state agentId does not match the supplied agent manifest",
        { details: { expected: manifest.id, actual: state.agentId } },
      ),
    };
  }
  if (state.version !== 1) {
    return {
      ok: false,
      error: new HarnessError(
        "execution.incompatible",
        `Unsupported ExecutionState version ${state.version}`,
      ),
    };
  }
  return { ok: true };
}
