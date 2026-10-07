import type { BoundToolDefinition } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import type { SavedToolCall } from "../types/execution.js";
import type { JsonValue } from "@nylorun/core/define";
import type { ToolOutcome, ToolResult } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";

export function toolResult(
  call: SavedToolCall,
  definition: BoundToolDefinition,
  outcome: ToolOutcome,
): ToolResult {
  const identity = { callId: call.callId, toolName: call.toolName };
  if (outcome.kind === "completed") {
    const checked = definition.outputSchema?.validate(outcome.output);
    if (checked && !checked.ok)
      return {
        ...identity,
        kind: "failed",
        code: "tool.invalid-output",
        message: checked.issues.map((issue) => issue.message).join("; "),
        details: { phase: "output", issues: checked.issues },
      };
    return copyJson({
      ...identity,
      kind: "completed",
      output: checked?.ok ? (checked.value as JsonValue) : outcome.output,
    });
  }
  if (
    outcome.kind === "failed" &&
    typeof outcome.code === "string" &&
    typeof outcome.message === "string"
  )
    return copyJson({
      ...identity,
      kind: "failed",
      code: outcome.code,
      message: outcome.message,
      ...(typeof outcome.retryable === "boolean" ? { retryable: outcome.retryable } : {}),
    });
  if (outcome.kind === "denied" && typeof outcome.reason !== "string")
    throw new HarnessError("tool.invalid-tool-result", "Tool denial reason must be a string");
  if (outcome.kind === "denied" && typeof outcome.reason === "string")
    return copyJson({ ...identity, kind: "denied", reason: outcome.reason });
  throw new HarnessError(
    "tool.invalid-tool-result",
    "Expected a completed, failed, or denied tool result",
  );
}
