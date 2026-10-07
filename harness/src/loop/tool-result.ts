import type { BoundToolDefinition } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import type { SavedToolCall } from "../types/execution.js";
import type { JsonValue } from "@nylorun/core/define";
import type { ToolOutcome, ToolResult, ToolResultFile } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";

export function toolResult(
  call: SavedToolCall,
  definition: BoundToolDefinition,
  outcome: ToolOutcome,
): ToolResult {
  const identity = { callId: call.callId, toolName: call.toolName };
  if (outcome.kind === "completed") {
    // A preview the Runtime made of a result too large to show is not the tool's output (R2b C11).
    const checked =
      outcome.truncated === true ? undefined : definition.outputSchema?.validate(outcome.output);
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
      ...(outcome.files?.length ? { files: outcome.files.map(fileOf) } : {}),
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

/** A file the model sees beside a tool's output (R2b C11): a media type and the host's reference. */
function fileOf(file: ToolResultFile): ToolResultFile {
  if (typeof file?.mediaType !== "string" || file.mediaType === "" || file.reference === undefined)
    throw new HarnessError(
      "tool.invalid-tool-result",
      "A tool result file needs a mediaType and a reference",
    );
  return { mediaType: file.mediaType, reference: file.reference };
}
