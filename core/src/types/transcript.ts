import type { ModelCandidate } from "./model.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { ToolResult } from "./tool.js";

export type InputEvent =
  | {
      readonly kind: "user-message" | "interrupt";
      readonly text: string;
      readonly metadata?: JsonObject;
    }
  | {
      readonly kind: "user-message" | "interrupt";
      readonly content: readonly UserContentPart[];
      /** Undefined for content-bearing events; retained for text-event narrowing compatibility. */
      readonly text?: undefined;
      readonly metadata?: JsonObject;
    }
  | {
      readonly kind: "approve";
      readonly interactionId: string;
      readonly approved: boolean;
    }
  | {
      readonly kind: "respond";
      readonly interactionId: string;
      readonly value: JsonValue;
    };

/** Ordered, model-visible user content. Media references stay host-owned JSON values. */
export type UserContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "media";
      readonly mediaType: string;
      readonly reference: JsonValue;
    };

export type MessageInput =
  | string
  | { readonly text: string; readonly metadata?: JsonObject }
  | {
      readonly content: readonly UserContentPart[];
      readonly metadata?: JsonObject;
    };
export type InteractionReply = Extract<
  InputEvent,
  { kind: "approve" | "respond" }
>;
export interface TranscriptInputEntry {
  readonly kind: "input";
  readonly turnId: string;
  readonly event: InputEvent;
}
export interface TranscriptCandidateEntry {
  readonly kind: "candidate";
  readonly turnId: string;
  readonly stepId: string;
  readonly candidate: ModelCandidate;
}
export interface TranscriptToolsEntry {
  readonly kind: "tool-results";
  readonly turnId: string;
  readonly stepId: string;
  readonly results: readonly ToolResult[];
}
export interface TranscriptFinalEntry {
  readonly kind: "final";
  readonly turnId: string;
  readonly stepId: string;
  readonly output: JsonValue;
}
/**
 * A summary that replaced the older part of the transcript (Model Calls §8). It is always
 * the first entry; the entries after it are the kept tail, sent verbatim.
 */
export interface TranscriptCompactionEntry {
  readonly kind: "compaction";
  readonly turnId: string;
  readonly stepId: string;
  readonly summary: string;
  readonly trigger: "threshold" | "overflow";
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}
export type TranscriptEntry =
  | TranscriptInputEntry
  | TranscriptCandidateEntry
  | TranscriptToolsEntry
  | TranscriptFinalEntry
  | TranscriptCompactionEntry;
