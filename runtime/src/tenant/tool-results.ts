/**
 * Tool results that fit (R2b C11, Q22–Q24): core shapes what an agent's remote MCP tool or HTTP
 * tool returned before it records the outcome (`harness-api/record.ts`), so no journal row,
 * event or prompt holds more of one result than the inline cap. The gate already refused an
 * answer past 8 MiB (`mcp.too-large`, `http.too-large`).
 *
 * - An `image`, `audio` or blob `resource` part becomes a file artifact of the session, and the
 *   part says `{artifactId, version, contentType, size}`. An image also goes to the model as a
 *   file (`ToolOutcome.files`), which the model call shows to a model that reads images (Q23).
 * - Text or JSON past `TOOL_RESULT_INLINE_BYTES` (32 KiB, Q22) becomes a file artifact, and the
 *   model gets `{truncated: true, artifactId, size, preview}`: the first 4 KiB and the last 1 KiB.
 *   In a result of several parts each part is shaped alone, the largest text first, until the
 *   whole fits; one that still does not is stored whole.
 * - A `resource_link` stays a link, never fetched, and a text resource that fits stays inline.
 * - A failed outcome's message is cut to its start and end.
 * - When an artifact cannot be stored (the Tenant's artifact limits, an Object store that
 *   fails), the preview stays and `dropped` says why the rest is gone: a result never passes
 *   the cap. Only an abort throws.
 * - **One step's results share a budget** (`STEP_RESULTS_BUDGET_BYTES`, 256 KiB), since the
 *   transcript keeps a step's results in one entry, one event: the record seam counts what the
 *   step's other results took, under the session lock, and gives this one the rest as its cap
 *   (`resultLimit`). Once the budget is spent, a result past `TOOL_RESULT_SMALL_BYTES` becomes a
 *   stub naming its artifact, its preview cut to fit `TOOL_RESULT_STUB_BYTES`.
 *
 * The model reads a stored result with `read_artifact` (`artifact-tool.ts`). Artifacts are the
 * session's, saved by our engine (`source: "engine"`), with the turn and the tool call on their
 * `artifact.created` event.
 */
import { READ_ARTIFACT_MAX_BYTES, type ToolResultFile } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import {
  MODEL_FILE_MAX_BYTES,
  extensionFor,
  isModelImage,
  isText,
  normalizeContentType,
} from "../artifacts/media-types.js";
import { uploadArtifact } from "../artifacts/service.js";
import { DEFAULT_CONTENT_TYPE } from "../blob/index.js";
import type { TenantContext } from "./context.js";
import { HttpError } from "./http.js";
import { toolIds } from "./transcript.js";

/** The most of one tool result that is recorded inline (Q22): 32 KiB, as JSON. */
export const TOOL_RESULT_INLINE_BYTES = READ_ARTIFACT_MAX_BYTES;
/** How much of a stored result's start, and of its end, the preview keeps. */
export const PREVIEW_HEAD_BYTES = 4 * 1024;
export const PREVIEW_TAIL_BYTES = 1024;
/**
 * The most one step's results may hold together: a step's results are one transcript entry, so
 * one event, which must stay well under S2's 1 MiB record.
 */
export const STEP_RESULTS_BUDGET_BYTES = 256 * 1024;
/** A result's cap once its step's budget is spent: a stub naming its artifact. */
export const TOOL_RESULT_STUB_BYTES = 512;
/** A result this small is never shaped, nor counted against its step's budget. */
export const TOOL_RESULT_SMALL_BYTES = 1024;

/** The call whose outcome is shaped, and the session its artifacts belong to. */
export interface ShapedCall {
  readonly request: HostEffect;
  readonly session: { readonly id: string; readonly ownerUserId: string };
  /** A remote MCP tool's: its output may be the server's content parts. */
  readonly mcp: boolean;
  /** This result's cap (`resultLimit`). Default `TOOL_RESULT_INLINE_BYTES`. */
  readonly limit?: number;
}

/** A result's cap when the other results of its step already took `used` bytes. */
export function resultLimit(used: number): number {
  return Math.max(
    TOOL_RESULT_STUB_BYTES,
    Math.min(TOOL_RESULT_INLINE_BYTES, STEP_RESULTS_BUDGET_BYTES - used)
  );
}

type Json = unknown;
type Part = Record<string, unknown>;

interface Shaping extends ShapedCall {
  readonly limit: number;
  readonly ctx: TenantContext;
  readonly signal: AbortSignal;
  readonly files: ToolResultFile[];
}

/** A stored artifact, as a shaped part names it; or why it could not be stored. */
type Stored =
  | {
      readonly artifactId: string;
      readonly version: number;
      readonly contentType: string;
      readonly size: number;
    }
  | { readonly dropped: string; readonly size: number };

/** The JSON size of `value` in bytes: what it adds to an event or a prompt. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/**
 * What a tool outcome's result weighs in its step's transcript entry: a completed one's output,
 * a failed one's message; 0 for anything else, such as a model call's outcome.
 */
export function resultBytes(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const outcome = value as { kind?: unknown; output?: unknown; message?: unknown };
  if (outcome.kind === "failed")
    return typeof outcome.message === "string" ? Buffer.byteLength(outcome.message) : 0;
  if (outcome.kind !== "completed" || outcome.output === undefined) return 0;
  return jsonBytes(outcome.output);
}

/**
 * False for an outcome `shapeToolOutcome` returns as it is, whatever made it: a model call's, a
 * small tool result with no parts. Spares a look at the effect for most outcomes.
 */
export function mayNeedShaping(value: unknown): boolean {
  const output = (value as { kind?: unknown; output?: unknown } | null)?.output;
  if ((value as { kind?: unknown } | null)?.kind === "completed" && Array.isArray(output))
    return true;
  return resultBytes(value) > TOOL_RESULT_SMALL_BYTES;
}

/**
 * The outcome `value` of `call`, shaped to fit its cap (see the module comment). An outcome that
 * fits and has no binary part comes back as it is.
 */
export async function shapeToolOutcome(
  ctx: TenantContext,
  call: ShapedCall,
  value: unknown,
  signal: AbortSignal
): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outcome = value as { kind?: unknown; output?: unknown; message?: unknown };
  const limit = call.limit ?? TOOL_RESULT_INLINE_BYTES;
  if (outcome.kind === "failed" && typeof outcome.message === "string")
    return Buffer.byteLength(outcome.message) > limit
      ? { ...outcome, message: cutMessage(outcome.message, limit) }
      : value;
  if (outcome.kind !== "completed" || outcome.output === undefined) return value;
  const shaping: Shaping = { ...call, limit, ctx, signal, files: [] };
  let output = outcome.output;
  if (call.mcp && isContentParts(output)) output = await shapeParts(shaping, output);
  let truncated = false;
  if (jsonBytes(output) > limit) {
    output = await storedWhole(shaping, output);
    truncated = true;
  }
  if (output === outcome.output) return value;
  return {
    ...outcome,
    output,
    ...(shaping.files.length > 0 ? { files: shaping.files } : {}),
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
        typeof (part as Part).type === "string"
    )
  );
}

/** An MCP result's parts: binary ones stored, then the largest text ones until the whole fits. */
async function shapeParts(shaping: Shaping, parts: readonly Part[]): Promise<Part[]> {
  const shaped: Part[] = [];
  for (const [index, part] of parts.entries()) shaped.push(await shapeBinary(shaping, part, index));
  const texts = shaped
    .map((part, index) => ({ index, bytes: textOf(part) === undefined ? 0 : jsonBytes(part) }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  for (const { index } of texts) {
    if (jsonBytes(shaped) <= shaping.limit) break;
    const part = shaped[index]!;
    const text = textOf(part)!;
    const resource = part.type === "resource" ? (part.resource as Part) : undefined;
    const contentType = resource ? textType(resource.mimeType) : "text/plain; charset=utf-8";
    const kept = await store(shaping, text, contentType, nameOf(shaping, contentType, index));
    shaped[index] = withPreview(
      {
        type: part.type,
        ...(resource && typeof resource.uri === "string" ? { uri: resource.uri } : {}),
        truncated: true,
        ...kept,
      },
      text,
      shaping.limit
    );
  }
  return shaped;
}

/** An `image`, `audio` or blob `resource` part, stored; any other part as it is. */
async function shapeBinary(shaping: Shaping, part: Part, index: number): Promise<Part> {
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
  const name = nameOf(shaping, contentType, index);
  const kept = await store(shaping, Buffer.from(data, "base64"), contentType, name);
  // An image the model reads goes to it as a file, beside the part (Q23).
  if (
    part.type === "image" &&
    "artifactId" in kept &&
    isModelImage(contentType) &&
    kept.size <= MODEL_FILE_MAX_BYTES
  )
    shaping.files.push({
      mediaType: contentType,
      reference: { artifactId: kept.artifactId, version: kept.version, name },
    });
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
async function storedWhole(shaping: Shaping, value: Json): Promise<Part> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const contentType = typeof value === "string" ? "text/plain; charset=utf-8" : "application/json";
  const kept = await store(shaping, text, contentType, nameOf(shaping, contentType));
  return withPreview({ truncated: true, ...kept }, text, shaping.limit);
}

/**
 * `stub` with the preview of `text`: the first 4 KiB and the last 1 KiB, or less, so that the
 * whole fits `limit` (a step's budget spent, R2b C11); none when even a little does not.
 */
function withPreview(stub: Part, text: string, limit: number): Part {
  let budget = Math.min(PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES, limit);
  for (;;) {
    const shaped = { ...stub, preview: previewOf(text, budget) };
    const over = jsonBytes(shaped) - limit;
    if (over <= 0 || budget === 0) return shaped;
    budget = budget - over < 64 ? 0 : budget - over;
  }
}

/** Stores `body` as an artifact of the call's session, or says why it was not. */
async function store(
  shaping: Shaping,
  body: string | Uint8Array,
  contentType: string,
  name: string
): Promise<Stored> {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const { ctx, request, session, signal } = shaping;
  const ids = toolIds(request.context);
  try {
    const saved = await uploadArtifact(
      ctx,
      {
        name,
        contentType,
        sessionId: session.id,
        source: "engine",
        turnId: request.turnId,
        ...("callId" in ids ? { callId: ids.callId } : {}),
      },
      bytes,
      // Into the call's own session only.
      { owner: session.ownerUserId },
      signal
    );
    return {
      artifactId: saved.artifact.artifactId,
      version: saved.version.version,
      contentType: saved.version.contentType,
      size: saved.version.size,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    // A limit is the Tenant's to raise; any other failure is the store's. Never the bytes.
    ctx.config.logger.warn("tool_result_not_stored", {
      session: session.id,
      effect: request.effectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      dropped:
        error instanceof HttpError
          ? `The result could not be stored as an artifact: ${error.message}`
          : "The result could not be stored as an artifact",
      size: bytes.byteLength,
    };
  }
}

/** A name for a stored result: the tool's, with the part's number and the type's extension. */
function nameOf(shaping: Shaping, contentType: string, index?: number): string {
  const tool = (shaping.request.toolName ?? "tool").replace(/[^A-Za-z0-9_.-]/gu, "_");
  const extension = extensionFor(contentType) ?? "bin";
  return `${tool.slice(0, 200)}-result${index === undefined ? "" : `-${index + 1}`}.${extension}`;
}

/**
 * The start and end of `text` in whole characters, `budget` bytes split four to one: by default
 * the first `PREVIEW_HEAD_BYTES` and the last `PREVIEW_TAIL_BYTES`.
 */
export function previewOf(text: string, budget = PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= budget) return text;
  if (budget <= 0) return "";
  const tailBytes = Math.floor(budget / 5);
  const head = utf8Boundary(bytes, budget - tailBytes, "down");
  const tail = utf8Boundary(bytes, bytes.byteLength - tailBytes, "up");
  return `${bytes.subarray(0, head).toString("utf8")}\n…\n${bytes.subarray(tail).toString("utf8")}`;
}

/** A message past `limit`: its start and end, and how long it was. */
function cutMessage(message: string, limit: number): string {
  const note = `\n(The message was ${Buffer.byteLength(message)} bytes; its middle is not shown.)`;
  const budget = Math.min(PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES, limit - note.length - 16);
  return `${previewOf(message, Math.max(0, budget))}${note}`;
}

/**
 * The nearest character boundary of the UTF-8 `bytes` at or before (`down`) or at or after
 * (`up`) byte `at`: never inside a character.
 */
export function utf8Boundary(bytes: Uint8Array, at: number, direction: "down" | "up"): number {
  let position = Math.max(0, Math.min(at, bytes.byteLength));
  const inside = (index: number) => index < bytes.byteLength && (bytes[index]! & 0xc0) === 0x80;
  if (direction === "down") while (position > 0 && inside(position)) position -= 1;
  else while (inside(position)) position += 1;
  return position;
}
