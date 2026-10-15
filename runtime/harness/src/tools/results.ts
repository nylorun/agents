/**
 * Tool results that fit (R2b C11, Q22–Q24; protocol 15): our engine shapes what a tool returned
 * before it reports the outcome (`effect.outcome`), since the record refuses an entry past the
 * Runtime limit `recordEntryBytes` and a step's results are one transcript entry. The Tool Gate
 * already refused an answer past `toolAnswerBytes` (`mcp.too-large`, `http.too-large`) and
 * scrubbed the credential values it echoed. A harness of your own may use these as they are.
 *
 * - An `image`, `audio` or blob `resource` part of an MCP result becomes a file artifact of the
 *   session (`artifact.write`, keyed by the call), and the part says `{artifactId, version,
 *   contentType, size}`. An image also goes to the model as a file (`ToolOutcome.files`) when the
 *   turn's model reads it (`fileView`); a text-only model gets the part's stub alone.
 * - Text or JSON past the call's cap becomes a file artifact, and the model gets `{truncated: true,
 *   artifactId, size, preview}`: the first `previewHeadBytes` and the last `previewTailBytes`. In
 *   a result of several parts each part is shaped alone, the largest text first, until the whole
 *   fits; one that still does not is stored whole.
 * - A `resource_link` stays a link, never fetched, and a text resource that fits stays inline.
 * - A failed outcome's message is cut to its start and end.
 * - When an artifact cannot be stored (the Tenant's artifact limits, say), the preview stays and
 *   `dropped` says why the rest is gone: a result never passes its cap. Only an abort throws.
 * - **One step's results share a budget** (`StepBudget`): `stepBudgetBytes`, or the record entry
 *   limit less `entryEnvelopeBytes` when that is less. Each result's cap is what the step's other
 *   results left of it, at most `resultInlineBytes` for an MCP or HTTP tool; once it is spent, a
 *   result becomes a stub naming its artifact, its preview cut to fit `stubBytes`.
 *
 * Each stored result's key (`spillKey`) is the call's effect id with the bytes' hash: a call run
 * again after a crash, which the gate answers with the same bytes, writes nothing new, and other
 * bytes never take the key of a preview already recorded. The model reads a stored result with
 * `read_artifact`.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_CONTENT_TYPE,
  extensionFor,
  isText,
  normalizeContentType,
} from "@nylorun/core/contracts";
import type { ToolResultFile } from "@nylorun/core/define";
import { fromBase64, type ModelDescriptor, type RuntimeLimits } from "@nylorun/core/harness-api";
import type { HostEffect } from "../run/durable.js";
import { fileView } from "../loop/model/files.js";
import { jsonBytes, utf8Boundary } from "./text-page.js";

export { jsonBytes, utf8Boundary } from "./text-page.js";

/** The harness's configuration of how our engine shapes tool results. */
export interface ToolResultConfig {
  /** The most of one MCP or HTTP tool result kept inline, as JSON. Default 32 KiB. */
  readonly resultInlineBytes: number;
  /** How much of a stored result's start the preview keeps. Default 4 KiB. */
  readonly previewHeadBytes: number;
  /** How much of a stored result's end the preview keeps. Default 1 KiB. */
  readonly previewTailBytes: number;
  /** The most one step's results hold together. Default 256 KiB. */
  readonly stepBudgetBytes: number;
  /** A result's cap once its step's budget is spent: a stub naming its artifact. Default 512. */
  readonly stubBytes: number;
  /** A result this small is never shaped. Default 1 KiB. */
  readonly smallBytes: number;
  /**
   * What a step's transcript entry holds beside its results (ids, calls, stubs), kept out of the
   * step's budget under the record entry limit. Default 4 KiB.
   */
  readonly entryEnvelopeBytes: number;
}

export const DEFAULT_TOOL_RESULT_CONFIG: ToolResultConfig = Object.freeze({
  resultInlineBytes: 32 * 1024,
  previewHeadBytes: 4 * 1024,
  previewTailBytes: 1024,
  stepBudgetBytes: 256 * 1024,
  stubBytes: 512,
  smallBytes: 1024,
  entryEnvelopeBytes: 4 * 1024,
});

/** `set` over the defaults. */
export function toolResultConfigOf(set?: Partial<ToolResultConfig>): ToolResultConfig {
  return Object.freeze({
    ...DEFAULT_TOOL_RESULT_CONFIG,
    ...Object.fromEntries(Object.entries(set ?? {}).filter(([, value]) => value !== undefined)),
  });
}

/** A stored artifact, as a shaped part names it; or why it could not be stored. */
export type Stored =
  | {
      readonly artifactId: string;
      readonly version: number;
      readonly contentType: string;
      readonly size: number;
    }
  | { readonly dropped: string; readonly size: number };

/** What shaping one outcome needs. */
export interface ShapeContext {
  readonly effect: HostEffect;
  /** This result's cap (`StepBudget.reserve`). */
  readonly limit: number;
  /** The turn's model (`turn.start.model`): whether an image goes to it as a file. */
  readonly model?: ModelDescriptor;
  readonly limits: Pick<RuntimeLimits, "modelFileBytes">;
  readonly config: ToolResultConfig;
  /** Stores `bytes` as an artifact of the call's session (`artifact.write`), or says why not. */
  store(
    bytes: Uint8Array,
    artifact: { readonly name: string; readonly contentType: string; readonly index?: number },
  ): Promise<Stored>;
}

type Part = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The key a stored result of effect `effectId` is written under (`artifact.write`): the part's
 * index (or `whole`) and the bytes' SHA-256, so the same bytes of the same call are one artifact,
 * whichever run stores them, and other bytes another.
 */
export function spillKey(effectId: string, index: number | "whole", bytes: Uint8Array): string {
  const content = createHash("sha256").update(bytes).digest("hex");
  return `tr:${createHash("sha256").update(`${effectId}\n${index}\n${content}`).digest("hex")}`;
}

/**
 * What a tool outcome's result weighs in its step's transcript entry: a completed one's output,
 * a failed one's message; 0 for anything else.
 */
export function resultBytes(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const outcome = value as { kind?: unknown; output?: unknown; message?: unknown };
  if (outcome.kind === "failed")
    return typeof outcome.message === "string" ? encoder.encode(outcome.message).byteLength : 0;
  if (outcome.kind !== "completed" || outcome.output === undefined) return 0;
  return jsonBytes(outcome.output);
}

/**
 * False for an outcome `shapeToolOutcome` returns as it is: a small tool result with no parts.
 * Spares the shaping of most outcomes.
 */
export function mayNeedShaping(
  value: unknown,
  config: Pick<ToolResultConfig, "smallBytes">,
): boolean {
  const output = (value as { kind?: unknown; output?: unknown } | null)?.output;
  if ((value as { kind?: unknown } | null)?.kind === "completed" && Array.isArray(output))
    return true;
  return resultBytes(value) > config.smallBytes;
}

/**
 * One run's tool results per model step (an agent's step: `[agent, stepId]`), which share one
 * transcript entry. A result reserves its cap from what the step's other results took, and is
 * counted once it is shaped; a replayed or recorded outcome is counted when it resolves. Shaping
 * is serialized per step (`serialize`), so parallel calls never spend the same room.
 */
export class StepBudget {
  /** The step budget: `stepBudgetBytes`, held under the record entry limit. */
  readonly budget: number;
  /** The most an MCP or HTTP tool result keeps inline: `resultInlineBytes`, held to the budget. */
  readonly inline: number;
  private readonly used = new Map<string, Map<string, number>>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: ToolResultConfig,
    limits: Pick<RuntimeLimits, "recordEntryBytes">,
  ) {
    this.budget = Math.max(
      config.stubBytes,
      Math.min(config.stepBudgetBytes, limits.recordEntryBytes - config.entryEnvelopeBytes),
    );
    this.inline = Math.min(config.resultInlineBytes, this.budget);
  }

  /** Counts `value`, the outcome of `effect`, toward its step (once per effect). */
  count(effect: HostEffect, value: unknown): void {
    const step = stepOf(effect);
    if (step === undefined) return;
    const effects = this.used.get(step) ?? new Map<string, number>();
    effects.set(effect.effectId, resultBytes(value));
    this.used.set(step, effects);
  }

  /**
   * The cap of `effect`'s result: what its step's other results left of the budget, at most
   * `inline` when `capped` (an MCP or HTTP tool), and never under a stub.
   */
  reserve(effect: HostEffect, capped: boolean): number {
    const step = stepOf(effect);
    let used = 0;
    for (const [id, bytes] of (step === undefined ? undefined : this.used.get(step)) ?? [])
      if (id !== effect.effectId) used += bytes;
    const room = this.budget - used;
    return Math.max(this.config.stubBytes, capped ? Math.min(this.inline, room) : room);
  }

  /** Runs `shape` after the shaping of `effect`'s step that came before it. */
  serialize<T>(effect: HostEffect, shape: () => Promise<T>): Promise<T> {
    const step = stepOf(effect) ?? effect.effectId;
    const previous = this.chains.get(step) ?? Promise.resolve();
    const next = previous.then(shape, shape);
    const settled = next.catch(() => undefined);
    this.chains.set(step, settled);
    void settled.then(() => {
      if (this.chains.get(step) === settled) this.chains.delete(step);
    });
    return next;
  }
}

/** The model step a tool call answers, and whose agent: its results share one transcript entry. */
function stepOf(effect: HostEffect): string | undefined {
  if (effect.kind !== "tool") return undefined;
  const stepId = (effect.context as { stepId?: unknown } | undefined)?.stepId;
  return typeof stepId === "string"
    ? JSON.stringify([effect.agent?.id ?? null, stepId])
    : undefined;
}

/**
 * The outcome `value` of `ctx.effect`, shaped to fit `ctx.limit` (see the module comment). An
 * outcome that fits and has no binary part comes back as it is. MCP content parts are read only
 * for an `mcp` call.
 */
export async function shapeToolOutcome(value: unknown, ctx: ShapeContext): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outcome = value as { kind?: unknown; output?: unknown; message?: unknown };
  const { limit } = ctx;
  if (outcome.kind === "failed" && typeof outcome.message === "string")
    return encoder.encode(outcome.message).byteLength > limit
      ? { ...outcome, message: cutMessage(outcome.message, limit, ctx.config) }
      : value;
  if (outcome.kind !== "completed" || outcome.output === undefined) return value;
  const files: ToolResultFile[] = [];
  let output = outcome.output;
  if (ctx.effect.target?.kind === "mcp" && isContentParts(output))
    output = await shapeParts(ctx, output, files);
  let truncated = false;
  if (jsonBytes(output) > limit) {
    output = await storedWhole(ctx, output);
    truncated = true;
  }
  if (output === outcome.output) return value;
  return {
    ...outcome,
    output,
    ...(files.length > 0 ? { files } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** True for an MCP `content` array: objects with a `type` each. */
function isContentParts(value: unknown): value is Part[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (part) =>
        !!part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        typeof (part as Part).type === "string",
    )
  );
}

/** An MCP result's parts: binary ones stored, then the largest text ones until the whole fits. */
async function shapeParts(
  ctx: ShapeContext,
  parts: readonly Part[],
  files: ToolResultFile[],
): Promise<Part[]> {
  const shaped: Part[] = [];
  for (const [index, part] of parts.entries())
    shaped.push(await shapeBinary(ctx, part, index, files));
  const texts = shaped
    .map((part, index) => ({ index, bytes: textOf(part) === undefined ? 0 : jsonBytes(part) }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  for (const { index } of texts) {
    if (jsonBytes(shaped) <= ctx.limit) break;
    const part = shaped[index]!;
    const text = textOf(part)!;
    const resource = part.type === "resource" ? (part.resource as Part) : undefined;
    const contentType = resource ? textType(resource.mimeType) : "text/plain; charset=utf-8";
    const kept = await ctx.store(encoder.encode(text), {
      name: nameOf(ctx, contentType, index),
      contentType,
      index,
    });
    shaped[index] = withPreview(
      {
        type: part.type,
        ...(resource && typeof resource.uri === "string" ? { uri: resource.uri } : {}),
        truncated: true,
        ...kept,
      },
      text,
      ctx.limit,
      ctx.config,
    );
  }
  return shaped;
}

/** An `image`, `audio` or blob `resource` part, stored; any other part as it is. */
async function shapeBinary(
  ctx: ShapeContext,
  part: Part,
  index: number,
  files: ToolResultFile[],
): Promise<Part> {
  const resource =
    part.type === "resource" && part.resource && typeof part.resource === "object"
      ? (part.resource as Part)
      : undefined;
  const data =
    part.type === "image" || part.type === "audio"
      ? part.data
      : resource !== undefined
        ? resource.blob
        : undefined;
  if (typeof data !== "string") return part;
  const declared = resource ? resource.mimeType : part.mimeType;
  const contentType =
    (typeof declared === "string" ? normalizeContentType(declared) : undefined) ??
    DEFAULT_CONTENT_TYPE;
  const name = nameOf(ctx, contentType, index);
  const kept = await ctx.store(fromBase64(data), { name, contentType, index });
  // An image the turn's model reads goes to it as a file, beside the part (Q23).
  if (part.type === "image" && "artifactId" in kept) {
    const file: ToolResultFile = {
      mediaType: contentType,
      reference: { artifactId: kept.artifactId, version: kept.version, name, size: kept.size },
    };
    if (fileView(file, ctx.model, ctx.limits).kind === "media") files.push(file);
  }
  return {
    type: part.type,
    ...(resource && typeof resource.uri === "string" ? { uri: resource.uri } : {}),
    ...("artifactId" in kept ? kept : { contentType, ...kept }),
  };
}

/** The text a part carries inline: a text part's, or a text resource's. */
function textOf(part: Part): string | undefined {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "resource" && part.resource && typeof part.resource === "object") {
    const text = (part.resource as Part).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function textType(declared: unknown): string {
  const type = typeof declared === "string" ? normalizeContentType(declared) : undefined;
  return type !== undefined && isText(type) ? type : "text/plain; charset=utf-8";
}

/** `value` stored whole, as text or JSON, and the preview the model gets. */
async function storedWhole(ctx: ShapeContext, value: unknown): Promise<Part> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const contentType = typeof value === "string" ? "text/plain; charset=utf-8" : "application/json";
  const kept = await ctx.store(encoder.encode(text), {
    name: nameOf(ctx, contentType),
    contentType,
  });
  return withPreview({ truncated: true, ...kept }, text, ctx.limit, ctx.config);
}

/**
 * `stub` with the preview of `text`: its start and end, or less, so that the whole fits `limit`
 * (a step's budget spent); none when even a little does not.
 */
function withPreview(stub: Part, text: string, limit: number, config: ToolResultConfig): Part {
  let budget = Math.min(config.previewHeadBytes + config.previewTailBytes, limit);
  for (;;) {
    const shaped = { ...stub, preview: previewOf(text, budget, config) };
    const over = jsonBytes(shaped) - limit;
    if (over <= 0 || budget === 0) return shaped;
    budget = budget - over < 64 ? 0 : budget - over;
  }
}

/** A name for a stored result: the tool's, with the part's number and the type's extension. */
function nameOf(ctx: ShapeContext, contentType: string, index?: number): string {
  const tool = (ctx.effect.toolName ?? "tool").replace(/[^A-Za-z0-9_.-]/gu, "_");
  const extension = extensionFor(contentType) ?? "bin";
  return `${tool.slice(0, 200)}-result${index === undefined ? "" : `-${index + 1}`}.${extension}`;
}

/**
 * The start and end of `text` in whole characters, `budget` bytes split as `previewHeadBytes` is
 * to `previewTailBytes`: by default the first 4 KiB and the last 1 KiB.
 */
export function previewOf(
  text: string,
  budget: number,
  config: Pick<ToolResultConfig, "previewHeadBytes" | "previewTailBytes">,
): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= budget) return text;
  if (budget <= 0) return "";
  const share = config.previewTailBytes / (config.previewHeadBytes + config.previewTailBytes || 1);
  const tailBytes = Math.floor(budget * share);
  const head = utf8Boundary(bytes, budget - tailBytes, "down");
  const tail = utf8Boundary(bytes, bytes.byteLength - tailBytes, "up");
  return `${decoder.decode(bytes.subarray(0, head))}\n…\n${decoder.decode(bytes.subarray(tail))}`;
}

/** A message past `limit`: its start and end, and how long it was. */
export function cutMessage(message: string, limit: number, config: ToolResultConfig): string {
  const note = `\n(The message was ${encoder.encode(message).byteLength} bytes; its middle is not shown.)`;
  const budget = Math.min(
    config.previewHeadBytes + config.previewTailBytes,
    limit - note.length - 16,
  );
  return `${previewOf(message, Math.max(0, budget), config)}${note}`;
}
