/**
 * Our engine's configuration of compaction (Model Calls §8): how much history it keeps verbatim,
 * the room it holds back for the reply, and the estimate it makes of what a prompt takes. A
 * harness sets any part of it (`createHarness({ compaction })`); each left out is its default.
 */

export interface CompactionConfig {
  /** The kept tail is at most this many tokens... */
  readonly keepTokens: number;
  /** ...and at most this share of the context window. */
  readonly keepShare: number;
  /** Room held back for the reply when the model reports no output limit. */
  readonly reserveTokens: number;
  /** The most room held back for the reply... */
  readonly maxReserveTokens: number;
  /** ...and at most this share of the context window. */
  readonly maxReserveShare: number;
  /** Tool inputs and results are clipped to this many characters in the summarizer's input. */
  readonly clipChars: number;
  /** Tokens the summary instructions, format and previous summary take in a summary call. */
  readonly summaryOverheadTokens: number;
  /** Tokens one image counts for in the estimate. */
  readonly imageTokens: number;
  /** Bytes per token of a file other than text or an image, in the estimate... */
  readonly fileBytesPerToken: number;
  /** ...and the most one such file counts for. */
  readonly fileTokensMax: number;
  /** The fewest tokens of history one summary call takes, however small the window. */
  readonly minChunkTokens: number;
  /** The fewest tokens a summary may have... */
  readonly minSummaryTokens: number;
  /** ...and the share of the reserve it may have. */
  readonly summaryShare: number;
  /** Characters per token for the heuristic estimate; the reserve absorbs its error. */
  readonly charsPerToken: number;
}

/** Compaction when the harness sets none. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = Object.freeze({
  keepTokens: 20_000,
  keepShare: 0.3,
  reserveTokens: 8_192,
  maxReserveTokens: 16_384,
  maxReserveShare: 0.25,
  clipChars: 2_000,
  summaryOverheadTokens: 1_024,
  imageTokens: 1_600,
  fileBytesPerToken: 8,
  fileTokensMax: 100_000,
  minChunkTokens: 1_000,
  minSummaryTokens: 256,
  summaryShare: 0.8,
  charsPerToken: 4,
});

/** `set` over the defaults. */
export function compactionConfigOf(set?: Partial<CompactionConfig>): CompactionConfig {
  return Object.freeze({
    ...DEFAULT_COMPACTION_CONFIG,
    ...Object.fromEntries(Object.entries(set ?? {}).filter(([, value]) => value !== undefined)),
  });
}
