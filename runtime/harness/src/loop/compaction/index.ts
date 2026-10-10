/**
 * Compaction (Model Calls §8): when history no longer fits the model's window, the engine
 * asks the model to summarize the older part and keeps the rest verbatim.
 *
 * The cut rules and the summary format are adapted from the compaction in pi's
 * `pi-agent-core` (MIT, Copyright (c) Earendil Works), rewritten for Nylorun's transcript.
 */
import type {
  JsonValue,
  ModelAdapter,
  ModelCall,
  ModelCandidate,
  ModelRequest,
  PromptItem,
  TranscriptCompactionEntry,
  TranscriptEntry,
} from "@nylorun/core/define";
import { HarnessError, isModelFailureOutcome } from "@nylorun/core/define";

/** Characters per token for the heuristic estimate; the reserve absorbs its error. */
const CHARS_PER_TOKEN = 4;
/** The kept tail is at most this many tokens, and at most this share of the window. */
const KEEP_TOKENS = 20_000;
const KEEP_SHARE = 0.3;
/** Room held back for the reply when the adapter does not report an output limit. */
const DEFAULT_RESERVE = 8_192;
const MAX_RESERVE = 16_384;
/** Tool inputs and results are clipped to this many characters in the summarizer's input. */
const CLIP = 2_000;
/** Tokens the summary instructions, format and previous summary take in a summary call. */
const SUMMARY_OVERHEAD = 1_024;

export interface ContextBudget {
  readonly contextWindow: number;
  readonly reserve: number;
}

/**
 * The window and output limit the adapter reported on the latest candidate
 * (`evidence.extras.contextWindow`, `maxOutputTokens`). Undefined until a model has answered.
 */
export function contextBudget(transcript: readonly TranscriptEntry[]): ContextBudget | undefined {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index]!;
    if (entry.kind !== "candidate") continue;
    const extras = entry.candidate.evidence?.extras;
    const window = extras?.contextWindow;
    if (typeof window !== "number" || window <= 0) continue;
    const output = extras?.maxOutputTokens;
    const reserve = Math.min(
      typeof output === "number" && output > 0 ? output : DEFAULT_RESERVE,
      MAX_RESERVE,
      Math.floor(window / 4),
    );
    return { contextWindow: window, reserve };
  }
  return undefined;
}

/**
 * Tokens the next prompt needs: the last reported usage, which already counts the
 * instructions, tools and everything before it, plus an estimate of what came after.
 * Without usage, everything is estimated.
 */
export function estimateTokens(transcript: readonly TranscriptEntry[]): number {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index]!;
    if (entry.kind !== "candidate" || !entry.candidate.usage) continue;
    const usage = entry.candidate.usage;
    const reported =
      usage.totalTokens ??
      (usage.inputTokens ?? 0) +
        (usage.cachedTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0) +
        (usage.outputTokens ?? 0);
    if (reported <= 0) continue;
    return reported + transcript.slice(index + 1).reduce((sum, item) => sum + entryTokens(item), 0);
  }
  return transcript.reduce((sum, item) => sum + entryTokens(item), 0);
}

/** A rough token count of what one entry contributes to a prompt. */
export function entryTokens(entry: TranscriptEntry): number {
  return Math.ceil(entryText(entry, Number.POSITIVE_INFINITY).length / CHARS_PER_TOKEN);
}

/**
 * Where the kept tail starts. It keeps about `keepTokens` of the newest entries, never
 * starts with tool results (their call stays with them), and never keeps the previous
 * summary. Returns 0 or 1 when there is nothing older to summarize.
 */
export function findCut(transcript: readonly TranscriptEntry[], keepTokens: number): number {
  const first = transcript[0]?.kind === "compaction" ? 1 : 0;
  let kept = 0;
  let cut = transcript.length;
  while (cut > first) {
    const tokens = entryTokens(transcript[cut - 1]!);
    if (kept + tokens > keepTokens && cut < transcript.length) break;
    kept += tokens;
    cut--;
  }
  // Tool results belong with the call that asked for them.
  while (cut > first && transcript[cut]?.kind === "tool-results") cut--;
  return cut;
}

export interface CompactionInput {
  readonly transcript: readonly TranscriptEntry[];
  readonly executionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly trigger: "threshold" | "overflow";
  readonly budget: ContextBudget | undefined;
  readonly invoke: ModelAdapter;
  readonly signal: AbortSignal;
}

/**
 * Summarize everything before the cut with one model call and return the new transcript,
 * or undefined when there is nothing older to summarize. The current turn's messages from
 * the user stay verbatim even when the cut falls inside the turn.
 */
export async function compact(
  input: CompactionInput,
): Promise<readonly TranscriptEntry[] | undefined> {
  const { transcript } = input;
  const tokensBefore = estimateTokens(transcript);
  const window = input.budget?.contextWindow ?? tokensBefore;
  const keepTokens = Math.max(1, Math.min(KEEP_TOKENS, Math.floor(window * KEEP_SHARE)));
  const cut = findCut(transcript, keepTokens);
  const previous = transcript[0]?.kind === "compaction" ? transcript[0] : undefined;
  const start = previous ? 1 : 0;
  if (cut <= start) return undefined;
  const older = transcript.slice(start, cut);
  // The user's request for the turn in progress is never summarized away.
  const request = older.filter(
    (entry) =>
      entry.kind === "input" &&
      entry.turnId === input.turnId &&
      (entry.event.kind === "user-message" || entry.event.kind === "interrupt"),
  );
  const tail = [...request, ...transcript.slice(cut)];
  const keptTokens = tail.reduce((sum, entry) => sum + entryTokens(entry), 0);
  const reserve = input.budget?.reserve ?? DEFAULT_RESERVE;
  const maxOutputTokens = Math.max(256, Math.floor(reserve * 0.8));
  // The summarizer sees at most what fits its window: older history is summarized in
  // chunks, each merged into the running summary. A single call would fail on a provider,
  // or lose the start of the history on a server that truncates silently.
  const chunkTokens = input.budget
    ? Math.max(1_000, input.budget.contextWindow - reserve - SUMMARY_OVERHEAD)
    : Number.POSITIVE_INFINITY;
  const chunks = chunked(older, chunkTokens);
  // A step can compact before its call and again after an overflow; each is its own effect.
  const base = `compaction-${input.stepId}${input.trigger === "overflow" ? "-overflow" : ""}`;
  let summary = previous?.summary;
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    const outcome = await input.invoke(summaryCall(input, chunk, summary, maxOutputTokens), {
      request: summaryRequest(input),
      invocationId: index === 0 ? base : `${base}-${index}`,
      signal: input.signal,
      compaction: {
        trigger: input.trigger,
        tokensBefore,
        keptTokens,
        ...(last ? {} : { partial: true }),
      },
      reportPreparedCall() {},
    });
    if (isModelFailureOutcome(outcome))
      throw new HarnessError(
        `model.${outcome.code}`,
        `Compacting the conversation failed: ${outcome.message}`,
      );
    summary = summaryText(outcome).trim();
    if (!summary)
      throw new HarnessError(
        "model.invalid_output",
        "Compacting the conversation failed: the model returned an empty summary.",
      );
  }
  if (!summary)
    throw new HarnessError(
      "model.invalid_output",
      "Compacting the conversation failed: the model returned an empty summary.",
    );
  const entry: TranscriptCompactionEntry = {
    kind: "compaction",
    turnId: input.turnId,
    stepId: input.stepId,
    summary,
    trigger: input.trigger,
    tokensBefore,
    tokensAfter: keptTokens + Math.ceil(summary.length / CHARS_PER_TOKEN),
  };
  return Object.freeze([Object.freeze(entry), ...tail]);
}

/** How a compaction entry reaches the model: a user message ahead of the kept tail. */
export function summaryPrompt(entry: TranscriptCompactionEntry): string {
  return [
    "Earlier parts of this conversation were summarized to fit the context window.",
    "<summary>",
    entry.summary,
    "</summary>",
  ].join("\n");
}

const SYSTEM = [
  "You summarize a conversation between a user and an AI agent that uses tools, so the agent",
  "can continue the work with a shorter context. Write for the agent, not the user.",
  "Keep facts exactly: names, identifiers, paths, numbers, decisions and open problems.",
  "Do not invent anything and do not continue the task yourself.",
].join(" ");

const FORMAT = [
  "Write the summary with these sections, leaving out a section that has nothing:",
  "## Goal",
  "## Constraints and preferences",
  "## Progress",
  "## Key decisions",
  "## Next steps",
  "## Critical context",
  "If a previous summary is given, merge it with the new conversation into one summary.",
].join("\n");

/** Consecutive runs of entries whose summarizer input stays under `limit` tokens. */
function chunked(
  entries: readonly TranscriptEntry[],
  limit: number,
): readonly (readonly TranscriptEntry[])[] {
  const chunks: TranscriptEntry[][] = [];
  let current: TranscriptEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const tokens = Math.ceil(entryText(entry, CLIP).length / CHARS_PER_TOKEN);
    if (current.length && size + tokens > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += tokens;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function summaryCall(
  input: CompactionInput,
  older: readonly TranscriptEntry[],
  previous: string | undefined,
  maxOutputTokens: number,
): ModelCall {
  const conversation = older
    .map((entry) => entryText(entry, CLIP))
    .filter((text) => text !== "")
    .join("\n\n");
  const text = [
    ...(previous ? ["<previous-summary>", previous, "</previous-summary>", ""] : []),
    "<conversation>",
    conversation,
    "</conversation>",
    "",
    FORMAT,
  ].join("\n");
  const prompt: PromptItem[] = [
    { kind: "instructions", role: "system", content: [{ type: "text", text: SYSTEM }] },
    { kind: "message", role: "user", content: [{ type: "text", text }] },
  ];
  return {
    prompt,
    tools: [],
    model: { controls: { maxOutputTokens } },
    executionId: input.executionId,
  };
}

function summaryRequest(input: CompactionInput): ModelRequest {
  return {
    executionId: input.executionId,
    turnId: input.turnId,
    stepId: input.stepId,
    configuration: {
      version: 1,
      instructions: [],
      tools: [],
      toolContracts: [],
      contributors: [],
    },
    instructions: [SYSTEM],
    context: { items: [], contributors: [] },
    transcript: [],
    arrivals: [],
    toolResults: [],
    tools: [],
  };
}

function summaryText(outcome: ModelCandidate | string): string {
  if (typeof outcome === "string") return outcome;
  return outcome.output.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** The model-visible text of one entry, with tool payloads clipped to `clip` characters. */
function entryText(entry: TranscriptEntry, clip: number): string {
  switch (entry.kind) {
    case "input": {
      const event = entry.event;
      if (event.kind === "user-message" || event.kind === "interrupt")
        return `[User]: ${
          "content" in event && event.content
            ? event.content
                .map((part) => (part.type === "text" ? part.text : `[${part.mediaType}]`))
                .join(" ")
            : (event.text ?? "")
        }`;
      if (event.kind === "approve")
        return `[User ${event.approved ? "approved" : "denied"} a request]`;
      if (event.kind === "respond") return `[User answered]: ${clipped(event.value, clip)}`;
      return "";
    }
    case "candidate":
      return entry.candidate.output
        .flatMap((block) => {
          if (block.type === "text") return block.text ? [`[Assistant]: ${block.text}`] : [];
          if (block.type === "json") return [`[Assistant]: ${clipped(block.value, clip)}`];
          if (block.type === "tool-call")
            return [`[Assistant called ${block.name}]: ${clipped(block.args, clip)}`];
          return [];
        })
        .join("\n");
    case "tool-results":
      return entry.results
        .map((result) =>
          result.kind === "completed"
            ? `[Tool ${result.toolName} result]: ${clipped(result.output as JsonValue, clip)}`
            : result.kind === "denied"
              ? `[Tool ${result.toolName} denied]: ${result.reason ?? ""}`
              : `[Tool ${result.toolName} failed]: ${result.message}`,
        )
        .join("\n");
    case "final":
      return "";
    case "compaction":
      return summaryPrompt(entry);
  }
}

function clipped(value: JsonValue | undefined, clip: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= clip
    ? text
    : `${text.slice(0, clip)}… [${text.length - clip} more characters]`;
}
