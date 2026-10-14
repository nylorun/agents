/**
 * What a harness writes into the session's record besides its effects (R4.5): transcript
 * entries, and the effect id rule replays depend on.
 *
 * Transcript. A session's transcript is shared by every turn: a run reads it once
 * (`transcript.read`), and its output edits it (`TurnOutput.transcript`, a list of
 * `TranscriptUpdate`s whose `entries` are `TranscriptEntry`s). History, `transcript.read` and the
 * next turn's cursor fold these edits, so a harness writes the five published kinds only.
 *
 * Effect ids. Core hands a run the completed outcomes of its segment whose effect id starts with
 * `<turnId>:<segment>:`, and a harness replays them instead of calling again. An id must be
 * derived from stable names, never call order, so a run that starts over asks for the same ids.
 */
import { z } from "zod";

const json = z.unknown();
const jsonObject = z.record(z.string(), z.unknown());

/** One block of a model candidate's output. */
export const ModelOutputBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), providerMetadata: jsonObject.optional() }),
  z.object({ type: z.literal("reasoning"), text: z.string(), providerMetadata: jsonObject.optional() }),
  z.object({ type: z.literal("json"), value: json }),
  z.object({
    type: z.literal("tool-call"),
    id: z.string(),
    name: z.string(),
    args: jsonObject,
    raw: z.string().optional(),
    providerMetadata: jsonObject.optional(),
  }),
]);

/** A model's answer: what the Model Gate's `outcome` is when the call worked. */
export const ModelCandidateSchema = z.object({
  output: z.array(ModelOutputBlockSchema),
  finishReason: z.enum(["stop", "length", "tool-calls", "content-filter", "other"]).optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      cachedTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
      costUsd: z.number().optional(),
    })
    .optional(),
  evidence: jsonObject.optional(),
});

/** One tool call's result, as the model sees it next. */
export const ToolResultSchema = z.discriminatedUnion("kind", [
  z.object({
    callId: z.string(),
    toolName: z.string(),
    kind: z.literal("completed"),
    output: json,
    files: z.array(json).optional(),
  }),
  z.object({ callId: z.string(), toolName: z.string(), kind: z.literal("denied"), reason: z.string() }),
  z.object({
    callId: z.string(),
    toolName: z.string(),
    kind: z.literal("failed"),
    code: z.string(),
    message: z.string(),
    details: json.optional(),
    retryable: z.boolean().optional(),
  }),
]);

/** What started a turn: a user message (text or content parts), or an answer to a question. */
export const InputEventSchema = z.union([
  z.object({
    kind: z.enum(["user-message", "interrupt"]),
    text: z.string(),
    metadata: jsonObject.optional(),
  }),
  z.object({
    kind: z.enum(["user-message", "interrupt"]),
    content: z.array(json),
    metadata: jsonObject.optional(),
  }),
  z.object({ kind: z.literal("approve"), interactionId: z.string(), approved: z.boolean() }),
  z.object({ kind: z.literal("respond"), interactionId: z.string(), value: json }),
]);

/**
 * One transcript entry. Every entry names its turn; a step's entries share a `stepId` (the model
 * candidate, then its tools' results). `compaction` is always first: a summary that replaced the
 * older part, followed by the kept tail.
 */
export const TranscriptEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), turnId: z.string(), event: InputEventSchema }),
  z.object({ kind: z.literal("candidate"), turnId: z.string(), stepId: z.string(), candidate: ModelCandidateSchema }),
  z.object({ kind: z.literal("tool-results"), turnId: z.string(), stepId: z.string(), results: z.array(ToolResultSchema) }),
  z.object({ kind: z.literal("final"), turnId: z.string(), stepId: z.string(), output: json }),
  z.object({
    kind: z.literal("compaction"),
    turnId: z.string(),
    stepId: z.string(),
    summary: z.string(),
    trigger: z.enum(["threshold", "overflow"]),
    tokensBefore: z.number(),
    tokensAfter: z.number(),
    files: z.array(z.string()).optional(),
  }),
]);

/** The prefix every effect id of a segment carries. */
export function effectIdPrefix(turnId: string, segment: number): string {
  return `${turnId}:${segment}:`;
}

/**
 * An effect's id: `<turnId>:<segment>:<kind>:<identity>`, where `identity` names the effect
 * stably within the segment (the model step's invocation id, a tool call's id).
 */
export function effectIdOf(turnId: string, segment: number, kind: string, identity: string): string {
  return `${effectIdPrefix(turnId, segment)}${kind}:${identity}`;
}

/** True when `effectId` is one of the segment's, so core replays its outcome to the segment. */
export function isEffectIdOf(effectId: string, turnId: string, segment: number): boolean {
  return effectId.startsWith(effectIdPrefix(turnId, segment));
}
