import { HarnessError } from "@nylorun/core/define";
import { normalizeCandidate } from "./model/normalize.js";
import type {
  InputEvent,
  TranscriptEntry,
  TranscriptToolsEntry,
  UserContentPart,
} from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import { assertJson, copyJson, copyJsonObject } from "@nylorun/core/define";

export function validateTranscript(value: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  try {
    if (!Array.isArray(value)) fail("Transcript must be an array");
    return Object.freeze(value.map((entry, index) => entryAt(entry, index)));
  } catch (cause) {
    if (cause instanceof HarnessError && cause.code === "execution.invalid-state") throw cause;
    throw new HarnessError("execution.invalid-state", "Transcript contains invalid typed JSON", {
      cause,
    });
  }
}

function entryAt(value: unknown, index: number): TranscriptEntry {
  if (!value || typeof value !== "object") fail(`Transcript entry ${index} must be an object`);
  const entry = value as Record<string, unknown>;
  requiredString(entry.kind, `Transcript entry ${index} kind`);
  requiredString(entry.turnId, `Transcript entry ${index} turnId`);
  switch (entry.kind) {
    case "input":
      exactKeys(entry, ["kind", "turnId", "event"], `Transcript entry ${index}`);
      return Object.freeze({
        kind: "input",
        turnId: entry.turnId as string,
        event: inputEvent(entry.event, index),
      });
    case "candidate": {
      exactKeys(entry, ["kind", "turnId", "stepId", "candidate"], `Transcript entry ${index}`);
      requiredString(entry.stepId, `Transcript entry ${index} stepId`);
      try {
        validateSeedCandidate(entry.candidate, index);
        return Object.freeze({
          kind: "candidate",
          turnId: entry.turnId as string,
          stepId: entry.stepId as string,
          candidate: normalizeCandidate(entry.candidate as never),
        });
      } catch (cause) {
        throw new HarnessError(
          "execution.invalid-state",
          `Invalid candidate at transcript ${index}`,
          {
            cause,
          },
        );
      }
    }
    case "tool-results": {
      exactKeys(entry, ["kind", "turnId", "stepId", "results"], `Transcript entry ${index}`);
      requiredString(entry.stepId, `Transcript entry ${index} stepId`);
      if (!Array.isArray(entry.results))
        fail(`Transcript entry ${index} tool results must be an array`);
      const result: TranscriptToolsEntry = Object.freeze({
        kind: "tool-results",
        turnId: entry.turnId as string,
        stepId: entry.stepId as string,
        results: Object.freeze(
          entry.results.map((item, resultIndex) => toolResult(item, resultIndex)),
        ),
      });
      return result;
    }
    case "compaction": {
      exactKeys(
        entry,
        ["kind", "turnId", "stepId", "summary", "trigger", "tokensBefore", "tokensAfter"],
        `Transcript entry ${index}`,
      );
      requiredString(entry.stepId, `Transcript entry ${index} stepId`);
      if (typeof entry.summary !== "string") fail(`Transcript entry ${index} summary`);
      if (entry.trigger !== "threshold" && entry.trigger !== "overflow")
        fail(`Transcript entry ${index} trigger`);
      for (const key of ["tokensBefore", "tokensAfter"] as const)
        if (!Number.isInteger(entry[key]) || (entry[key] as number) < 0)
          fail(`Transcript entry ${index} ${key}`);
      return Object.freeze({
        kind: "compaction",
        turnId: entry.turnId as string,
        stepId: entry.stepId as string,
        summary: entry.summary,
        trigger: entry.trigger,
        tokensBefore: entry.tokensBefore as number,
        tokensAfter: entry.tokensAfter as number,
      });
    }
    case "final":
      exactKeys(entry, ["kind", "turnId", "stepId", "output"], `Transcript entry ${index}`);
      requiredString(entry.stepId, `Transcript entry ${index} stepId`);
      assertJson(entry.output, `Transcript entry ${index} output`);
      return Object.freeze({
        kind: "final",
        turnId: entry.turnId as string,
        stepId: entry.stepId as string,
        output: copyJson(entry.output),
      });
    default:
      fail(`Transcript entry ${index} has unknown kind '${String(entry.kind)}'`);
  }
}

function inputEvent(value: unknown, index: number): InputEvent {
  if (!value || typeof value !== "object") fail(`Transcript input ${index} must be an object`);
  const event = value as Record<string, unknown>;
  switch (event.kind) {
    case "user-message":
    case "interrupt":
      if ("content" in event) {
        exactKeys(event, ["kind", "content", "metadata"], `Transcript input ${index}`);
        if (!Array.isArray(event.content))
          fail(`Transcript input ${index} content must be an array`);
        return Object.freeze({
          kind: event.kind,
          content: contentParts(event.content, index),
          ...(event.metadata === undefined
            ? {}
            : { metadata: copyJsonObject(event.metadata, `transcript input ${index} metadata`) }),
        });
      }
      exactKeys(event, ["kind", "text", "metadata"], `Transcript input ${index}`);
      if (typeof event.text !== "string") fail(`Transcript input ${index} text must be a string`);
      return Object.freeze({
        kind: event.kind,
        text: event.text,
        ...(event.metadata === undefined
          ? {}
          : { metadata: copyJsonObject(event.metadata, `transcript input ${index} metadata`) }),
      });
    case "approve":
      exactKeys(event, ["kind", "interactionId", "approved"], `Transcript input ${index}`);
      requiredString(event.interactionId, `Transcript input ${index} interactionId`);
      if (typeof event.approved !== "boolean")
        fail(`Transcript input ${index} approved must be a boolean`);
      return Object.freeze({
        kind: "approve",
        interactionId: event.interactionId as string,
        approved: event.approved,
      });
    case "respond":
      exactKeys(event, ["kind", "interactionId", "value"], `Transcript input ${index}`);
      requiredString(event.interactionId, `Transcript input ${index} interactionId`);
      assertJson(event.value, `transcript input ${index} value`);
      return Object.freeze({
        kind: "respond",
        interactionId: event.interactionId as string,
        value: copyJson(event.value),
      });
    default:
      fail(`Transcript input ${index} has unknown kind '${String(event.kind)}'`);
  }
}

function contentParts(value: readonly unknown[], inputIndex: number): readonly UserContentPart[] {
  return Object.freeze(
    value.map((value, partIndex) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`Transcript input ${inputIndex} content part ${partIndex} must be an object`);
      const part = value as Record<string, unknown>;
      if (part.type === "text") {
        exactKeys(
          part,
          ["type", "text"],
          `Transcript input ${inputIndex} content part ${partIndex}`,
        );
        if (typeof part.text !== "string")
          fail(`Transcript input ${inputIndex} text part ${partIndex} must contain text`);
        return Object.freeze({ type: "text" as const, text: part.text });
      }
      if (part.type === "media") {
        exactKeys(
          part,
          ["type", "mediaType", "reference"],
          `Transcript input ${inputIndex} content part ${partIndex}`,
        );
        if (typeof part.mediaType !== "string" || part.mediaType === "")
          fail(`Transcript input ${inputIndex} media part ${partIndex} must contain mediaType`);
        assertJson(part.reference, `transcript input ${inputIndex} media reference ${partIndex}`);
        return Object.freeze({
          type: "media" as const,
          mediaType: part.mediaType,
          reference: copyJson(part.reference),
        });
      }
      fail(`Transcript input ${inputIndex} content part ${partIndex} has unknown type`);
    }),
  );
}

function toolResult(value: unknown, index: number): ToolResult {
  if (!value || typeof value !== "object") fail(`Tool result ${index} must be an object`);
  const result = value as Record<string, unknown>;
  requiredString(result.callId, `Tool result ${index} callId`);
  requiredString(result.toolName, `Tool result ${index} toolName`);
  const base = { callId: result.callId as string, toolName: result.toolName as string };
  switch (result.kind) {
    case "completed":
      exactKeys(result, ["callId", "toolName", "kind", "output"], `Tool result ${index}`);
      assertJson(result.output, `tool result ${index} output`);
      return Object.freeze({ ...base, kind: "completed", output: copyJson(result.output) });
    case "denied":
      exactKeys(result, ["callId", "toolName", "kind", "reason"], `Tool result ${index}`);
      if (typeof result.reason !== "string") fail(`Tool result ${index} reason must be a string`);
      return Object.freeze({ ...base, kind: "denied", reason: result.reason });
    case "failed":
      exactKeys(
        result,
        ["callId", "toolName", "kind", "code", "message", "details"],
        `Tool result ${index}`,
      );
      if (typeof result.code !== "string" || typeof result.message !== "string")
        fail(`Tool result ${index} code and message must be strings`);
      return Object.freeze({
        ...base,
        kind: "failed",
        code: result.code,
        message: result.message,
        ...(result.details === undefined
          ? {}
          : { details: validationDetails(result.details, index) }),
      });
    default:
      fail(`Tool result ${index} has unknown kind '${String(result.kind)}'`);
  }
}

function validationDetails(
  value: unknown,
  index: number,
): NonNullable<Extract<ToolResult, { kind: "failed" }>["details"]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`Tool result ${index} details must be an object`);
  const details = value as Record<string, unknown>;
  exactKeys(details, ["phase", "issues"], `Tool result ${index} details`);
  if (details.phase !== "input" && details.phase !== "output")
    fail(`Tool result ${index} details phase must be input or output`);
  if (!Array.isArray(details.issues)) fail(`Tool result ${index} details issues must be an array`);
  return Object.freeze({
    phase: details.phase,
    issues: Object.freeze(
      details.issues.map((issue, issueIndex) => {
        if (!issue || typeof issue !== "object" || Array.isArray(issue))
          fail(`Tool result ${index} details issue ${issueIndex} must be an object`);
        const item = issue as Record<string, unknown>;
        exactKeys(
          item,
          ["path", "code", "message"],
          `Tool result ${index} details issue ${issueIndex}`,
        );
        if (!Array.isArray(item.path))
          fail(`Tool result ${index} details issue ${issueIndex} path must be an array`);
        if (item.path.some((part) => typeof part !== "string" && typeof part !== "number"))
          fail(
            `Tool result ${index} details issue ${issueIndex} path must contain strings or numbers`,
          );
        if (typeof item.code !== "string" || typeof item.message !== "string")
          fail(`Tool result ${index} details issue ${issueIndex} code and message must be strings`);
        return Object.freeze({
          path: Object.freeze([...item.path] as (string | number)[]),
          code: item.code,
          message: item.message,
        });
      }),
    ),
  });
}

function validateSeedCandidate(value: unknown, index: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`Candidate at transcript ${index} must be an object`);
  const candidate = value as Record<string, unknown>;
  exactKeys(
    candidate,
    ["output", "finishReason", "usage", "evidence"],
    `Candidate at transcript ${index}`,
  );
  if (!Array.isArray(candidate.output))
    fail(`Candidate at transcript ${index} output must be an array`);
  candidate.output.forEach((value, blockIndex) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(`Candidate output ${blockIndex} at transcript ${index} must be an object`);
    const block = value as Record<string, unknown>;
    if (block.type === "text" || block.type === "reasoning") {
      exactKeys(block, ["type", "text", "providerMetadata"], `Candidate output ${blockIndex}`);
      if (typeof block.text !== "string")
        fail(`Candidate output ${blockIndex} text must be a string`);
      return;
    }
    if (block.type === "json") {
      exactKeys(block, ["type", "value"], `Candidate output ${blockIndex}`);
      assertJson(block.value, `Candidate output ${blockIndex} value`);
      return;
    }
    if (block.type === "tool-call") {
      exactKeys(
        block,
        ["type", "id", "name", "args", "raw", "providerMetadata"],
        `Candidate output ${blockIndex}`,
      );
      requiredString(block.id, `Candidate output ${blockIndex} id`);
      requiredString(block.name, `Candidate output ${blockIndex} name`);
      if (block.raw !== undefined && typeof block.raw !== "string")
        fail(`Candidate output ${blockIndex} raw must be a string`);
      copyJsonObject(block.args, `candidate output ${blockIndex} args`);
      return;
    }
    fail(`Candidate output ${blockIndex} has unknown kind '${String(block.type)}'`);
  });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${label} has unknown field '${key}'`);
}

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

function fail(message: string): never {
  throw new HarnessError("execution.invalid-state", message);
}
