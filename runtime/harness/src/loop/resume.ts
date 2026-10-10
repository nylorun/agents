import type { BoundToolDefinition } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import type { ExecutionState } from "../types/execution.js";
import { copyJson } from "@nylorun/core/define";
import type { normalizeInput } from "./state.js";
import { toolResult } from "./tool-result.js";

export function applyResume(
  state: ExecutionState,
  input: ReturnType<typeof normalizeInput>,
  definitions: Map<string, BoundToolDefinition>,
): ExecutionState {
  const plan = state.plan!;
  let matched = false;
  const calls = plan.calls.map((call) => {
    if (
      input.kind === "settle" &&
      call.status === "deferred" &&
      call.invocationId === input.invocationId
    ) {
      matched = true;
      return {
        ...call,
        status: "settled" as const,
        result: toolResult(call, definitions.get(call.invocationId)!, input.outcome),
      };
    }
    if (
      (input.kind === "approve" || input.kind === "respond") &&
      call.status === "interaction" &&
      call.interaction!.id === input.interactionId
    ) {
      if ((input.kind === "approve") !== (call.interaction!.kind === "approval"))
        throw new HarnessError(
          "execution.invalid-input",
          "Interaction response kind does not match the saved request",
        );
      matched = true;
      const { interaction: _, interactionPhase: __, resume: ___, ...rest } = call;
      if (input.kind === "approve" && !input.approved)
        return {
          ...rest,
          status: "settled" as const,
          result: {
            kind: "denied" as const,
            callId: call.callId,
            toolName: call.toolName,
            reason: "Approval rejected",
          },
        };
      return {
        ...rest,
        status: "pending" as const,
        resume: {
          interactionId: input.interactionId,
          kind: input.kind === "approve" ? ("approval" as const) : ("response" as const),
          ...(input.kind === "approve" ? { approved: input.approved } : { value: input.value }),
          ...(call.token === undefined ? {} : { token: call.token }),
        },
      };
    }
    return call;
  });
  if (!matched)
    throw new HarnessError(
      "execution.invalid-input",
      "Input does not match a pending approval, response, or deferred invocation",
    );
  return copyJson({ ...state, plan: { ...plan, calls } });
}
