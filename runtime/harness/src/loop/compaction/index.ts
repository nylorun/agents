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
import { HarnessError, isModelFailureOutcome, mediaReferenceOf } from "@nylorun/core/define";
import { isText, modelInputOf } from "@nylorun/core/contracts";
import type { ModelDescriptor } from "@nylorun/core/harness-api";
import { fileView, mediaReferenceLine, type FileViewContext } from "../model/files.js";
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from "./config.js";

export { DEFAULT_COMPACTION_CONFIG, compactionConfigOf, type CompactionConfig } from "./config.js";

export interface ContextBudget {
  readonly contextWindow: number;
  readonly reserve: number;
}

/**
 * The window and output limit the adapter reported on the latest candidate
 * (`evidence.extras.contextWindow`, `maxOutputTokens`). Before any answer reports them, the
 * turn's model descriptor's (`turn.start.model`); undefined without either. The reserve is the
 * output limit, held to `maxReserveTokens` and `maxReserveShare` of the window.
 */
export function contextBudget(
  transcript: readonly TranscriptEntry[],
  model?: Pick<ModelDescriptor, "contextWindow" | "maxOutputTokens">,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): ContextBudget | undefined {
  const reserveOf = (output: number, window: number) =>
    Math.min(output, config.maxReserveTokens, Math.floor(window * config.maxReserveShare));
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index]!;
    if (entry.kind !== "candidate") continue;
    const extras = entry.candidate.evidence?.extras;
    const window = extras?.contextWindow;
    if (typeof window !== "number" || window <= 0) continue;
    const output = extras?.maxOutputTokens;
    const reserve = reserveOf(
      typeof output === "number" && output > 0 ? output : config.reserveTokens,
      window,
    );
    return { contextWindow: window, reserve };
  }
  if (!model) return undefined;
  return {
    contextWindow: model.contextWindow,
    reserve: reserveOf(model.maxOutputTokens, model.contextWindow),
  };
}

/**
 * Tokens the next prompt needs: the last reported usage, which already counts the
 * instructions, tools and everything before it, plus an estimate of what came after.
 * Without usage, everything is estimated. The files of turn `turnId` go to the model as `files`
 * shows them (`fileView`, protocol 15) and count by how; those of an earlier turn the reported
 * call carried are reference lines now, and come off it.
 */
export function estimateTokens(
  transcript: readonly TranscriptEntry[],
  turnId?: string,
  files?: FileViewContext,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): number {
  const fileTokens = (item: TranscriptEntry) => filesTokens(item, files, config);
  const tokens = (item: TranscriptEntry) => entryTokens(item, config);
  const live = (item: TranscriptEntry) => (item.turnId === turnId ? fileTokens(item) : 0);
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
    const dropped =
      entry.turnId === turnId
        ? 0
        : transcript
            .slice(0, index)
            .reduce((sum, item) => sum + (item.turnId === entry.turnId ? fileTokens(item) : 0), 0);
    return Math.max(
      0,
      reported -
        dropped +
        transcript.slice(index + 1).reduce((sum, item) => sum + tokens(item) + live(item), 0),
    );
  }
  return transcript.reduce((sum, item) => sum + tokens(item) + live(item), 0);
}

/**
 * A rough token count of the files an entry names, as the model gets them: a note counts
 * nothing (its line is text), inlined text by its size, an image `imageTokens`, another file by
 * its size (`fileBytesPerToken`) up to `fileTokensMax`. Without `files`, each counts by its type.
 */
function filesTokens(
  entry: TranscriptEntry,
  files: FileViewContext | undefined,
  config: CompactionConfig,
): number {
  return filesOf(entry).reduce((sum, { part }) => {
    const size = mediaReferenceOf(part.reference)?.size ?? 0;
    if (files && fileView(part, files.model, files.limits).kind === "note") return sum;
    if (isText(part.mediaType)) return sum + Math.ceil(size / config.charsPerToken);
    if (modelInputOf(part.mediaType) === "image") return sum + config.imageTokens;
    return sum + Math.min(Math.ceil(size / config.fileBytesPerToken), config.fileTokensMax);
  }, 0);
}

/** The files an entry names (protocol 12): a message's media parts, and a tool result's files. */
function filesOf(
  entry: TranscriptEntry,
): { readonly line: string; readonly part: { mediaType: string; reference: JsonValue } }[] {
  if (entry.kind === "input") {
    const event = entry.event;
    if (
      (event.kind !== "user-message" && event.kind !== "interrupt") ||
      !("content" in event) ||
      !event.content
    )
      return [];
    return event.content.flatMap((part) =>
      part.type === "media" ? [{ line: mediaReferenceLine(part, "uploaded"), part }] : [],
    );
  }
  if (entry.kind === "tool-results")
    return entry.results.flatMap((result) =>
      result.kind === "completed" && result.files
        ? result.files.map((part) => ({
            line: mediaReferenceLine(part, { tool: result.toolName }),
            part,
          }))
        : [],
    );
  return [];
}

/** A rough token count of what one entry contributes to a prompt. */
export function entryTokens(
  entry: TranscriptEntry,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): number {
  return Math.ceil(entryText(entry, Number.POSITIVE_INFINITY).length / config.charsPerToken);
}

/**
 * Where the kept tail starts. It keeps about `keepTokens` of the newest entries, never
 * starts with tool results (their call stays with them), and never keeps the previous
 * summary. Returns 0 or 1 when there is nothing older to summarize.
 */
export function findCut(
  transcript: readonly TranscriptEntry[],
  keepTokens: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): number {
  const first = transcript[0]?.kind === "compaction" ? 1 : 0;
  let kept = 0;
  let cut = transcript.length;
  while (cut > first) {
    const tokens = entryTokens(transcript[cut - 1]!, config);
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
  /** How the turn's files reach the model, for the estimate (`fileView`). */
  readonly files?: FileViewContext;
  readonly invoke: ModelAdapter;
  readonly signal: AbortSignal;
  /** The harness's configuration of compaction. Default `DEFAULT_COMPACTION_CONFIG`. */
  readonly config?: CompactionConfig;
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
  const config = input.config ?? DEFAULT_COMPACTION_CONFIG;
  const tokensBefore = estimateTokens(transcript, input.turnId, input.files, config);
  const window = input.budget?.contextWindow ?? tokensBefore;
  const keepTokens = Math.max(
    1,
    Math.min(config.keepTokens, Math.floor(window * config.keepShare)),
  );
  const cut = findCut(transcript, keepTokens, config);
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
  // The files the summarized part named stay readable by their reference lines (protocol 12).
  const files = [
    ...new Set([
      ...(previous?.files ?? []),
      ...older
        .filter((entry) => !request.includes(entry))
        .flatMap((entry) => filesOf(entry).map(({ line }) => line)),
    ]),
  ];
  const keptTokens = tail.reduce((sum, entry) => sum + entryTokens(entry, config), 0);
  const reserve = input.budget?.reserve ?? config.reserveTokens;
  const maxOutputTokens = Math.max(
    config.minSummaryTokens,
    Math.floor(reserve * config.summaryShare),
  );
  // The summarizer sees at most what fits its window: older history is summarized in
  // chunks, each merged into the running summary. A single call would fail on a provider,
  // or lose the start of the history on a server that truncates silently.
  const chunkTokens = input.budget
    ? Math.max(
        config.minChunkTokens,
        input.budget.contextWindow - reserve - config.summaryOverheadTokens,
      )
    : Number.POSITIVE_INFINITY;
  const chunks = chunked(older, chunkTokens, config);
  // A step can compact before its call and again after an overflow; each is its own effect.
  const base = `compaction-${input.stepId}${input.trigger === "overflow" ? "-overflow" : ""}`;
  let summary = previous?.summary;
  for (const [index, chunk] of chunks.entries()) {
    const outcome = await input.invoke(
      summaryCall(input, chunk, summary, maxOutputTokens, config.clipChars),
      {
        request: summaryRequest(input),
        invocationId: index === 0 ? base : `${base}-${index}`,
        signal: input.signal,
        compaction: {
          trigger: input.trigger,
          tokensBefore,
          keptTokens,
        },
        reportPreparedCall() {},
      },
    );
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
    tokensAfter: keptTokens + Math.ceil(summary.length / config.charsPerToken),
    ...(files.length > 0 ? { files } : {}),
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
    ...(entry.files?.length ? ["Files in this session:", ...entry.files] : []),
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
  config: CompactionConfig,
): readonly (readonly TranscriptEntry[])[] {
  const chunks: TranscriptEntry[][] = [];
  let current: TranscriptEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const tokens = Math.ceil(entryText(entry, config.clipChars).length / config.charsPerToken);
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
  clip: number,
): ModelCall {
  const conversation = older
    .map((entry) => entryText(entry, clip))
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
                .map((part) =>
                  part.type === "text" ? part.text : mediaReferenceLine(part, "uploaded"),
                )
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
            ? [
                `[Tool ${result.toolName} result]: ${clipped(result.output as JsonValue, clip)}`,
                ...(result.files ?? []).map((file) =>
                  mediaReferenceLine(file, { tool: result.toolName }),
                ),
              ].join("\n")
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
