# Compaction of the transcript

Keeps a long conversation inside the model's context: estimates what the transcript takes, finds the tail to keep verbatim, and replaces the older part with one summary entry. `config.ts` holds the settings and their defaults; `index.ts` the estimate, the cut and the compaction itself.

## Interface

- `CompactionConfig`, `compactionConfigOf(set?)`, `DEFAULT_COMPACTION_CONFIG` (`config.ts`): `threshold`, `keepTokens`, `keepShare`, `reserveTokens`, `maxReserveTokens`, `maxReserveShare`, `clipChars`, `summaryOverheadTokens`, `imageTokens`, `fileBytesPerToken`, `fileTokensMax`, `minChunkTokens`, `minSummaryTokens`, `summaryShare`, `charsPerToken`.
- `estimateTokens`, `entryTokens` (`index.ts`): what a transcript, or one entry, takes in tokens.
- `contextBudget`, `ContextBudget` (`index.ts`): the room a request has in the model's window.
- `compactionLimit` (`index.ts`): the token count past which a transcript is compacted.
- `findCut` (`index.ts`): where the kept tail starts.
- `compact(input)`, `CompactionInput` (`index.ts`): compacts the transcript, asking for the summary through the call it is given.
- `summaryPrompt(entry)` (`index.ts`): the prompt that summarizes a `TranscriptCompactionEntry`.

## Rules

- The kept tail is at most `keepTokens` and at most `keepShare` of the context window (`config.ts`).
- Compaction starts at `threshold` when that is lower than the window less the reply reserve; without it, only at the window's line (`config.ts`).
- The reply reserve is `reserveTokens` when the model reports no output limit, held under `maxReserveTokens` and `maxReserveShare` of the window (`config.ts`).
- One summary call takes at least `minChunkTokens` of history, and a summary has at least `minSummaryTokens` and at most `summaryShare` of the reserve (`config.ts`).
- Tool inputs and results are clipped to `clipChars` in the summarizer's input (`config.ts`).
- Estimation is `charsPerToken` characters a token, `imageTokens` an image and `fileBytesPerToken` bytes a token up to `fileTokensMax` for a file that is neither text nor an image (`config.ts`).

## Side effects

- A compaction's summary is a model call; the transcript records one `compaction` entry and the kept tail in place of the summarized history, never an assistant message, and a durable run journals the call with `purpose: "summary"` (`index.ts`, `compact`; `../../run/durable.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
