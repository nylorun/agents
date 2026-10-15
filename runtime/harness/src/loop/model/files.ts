/**
 * How each file reaches the model (protocol 15): the harness decides, not the Model Gate. A file
 * of the turn in progress (a message's media part, a file a tool returned, a `read_artifact`
 * load) goes as one of three:
 *
 * - `media`: the media part itself, an artifact reference the Model Gate fetches and sends in
 *   the provider's own block (an image, a PDF, an Office document, audio, video the model reads);
 * - `text`: the file's text, read here over the artifact seam (`artifact.read`) and inlined as a
 *   `<file>` block;
 * - `note`: a line saying why the model does not see it, which we write.
 *
 * `fileView` decides from the model descriptor (`turn.start.model`) and the Runtime limits
 * (`turn.start.limits`); without a descriptor the model is taken to read text and images. A
 * harness of its own may use these as they are, or decide otherwise: the gate refuses only what
 * the provider cannot take (`unsupported_input`).
 */
import {
  essence,
  inputLabel,
  isModelImage,
  isText,
  modelInputOf,
  type ModelInput,
} from "@nylorun/core/contracts";
import {
  copyJson,
  mediaReferenceOf,
  type JsonValue,
  type MediaReference,
  type PromptContentPart,
} from "@nylorun/core/define";
import {
  HarnessApiError,
  type ArtifactMeta,
  type ModelDescriptor,
  type RuntimeLimits,
} from "@nylorun/core/harness-api";

/** A media part: its declared type and the reference the Runtime made (`MediaReference`). */
export interface FilePart {
  readonly mediaType: string;
  readonly reference: JsonValue;
}

/** How one file reaches the model. */
export type FileView =
  /** The part goes as it is: the Model Gate fetches the artifact and sends it natively. */
  | { readonly kind: "media" }
  /** The harness reads it with `artifact.read` and inlines it as a `<file>` block. */
  | { readonly kind: "text" }
  /** The model is told why it does not see the file. */
  | { readonly kind: "note"; readonly why: string };

/** What `fileView` decides from: the turn's model and the Runtime limits. */
export interface FileViewContext {
  /** `turn.start.model`; undefined when the Runtime sent none. */
  readonly model?: ModelDescriptor;
  readonly limits: Pick<RuntimeLimits, "modelFileBytes">;
}

/** One answer of the artifact seam, as `representFiles` reads it. */
export interface FileChunk {
  readonly artifact: ArtifactMeta;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

/** What `representFiles` needs: the decision's inputs, and the run's artifact reads. */
export interface FileContext extends FileViewContext {
  readonly limits: Pick<RuntimeLimits, "modelFileBytes" | "modelCallBytes" | "chunkBytes">;
  /**
   * Reads `length` bytes of the artifact version from `offset` (`artifact.read`). A refusal of
   * the seam (`HarnessApiError`) becomes a note; any other error is the run's.
   */
  read(
    reference: MediaReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<FileChunk>;
}

/** What a model reads when the Runtime sent no descriptor (a scripted provider, say). */
const FALLBACK_INPUTS: readonly ModelInput[] = Object.freeze(["text", "image"]);

/** How the file `part` names reaches a model that reads `model.inputs`. */
export function fileView(
  part: FilePart,
  model: ModelDescriptor | undefined,
  limits: Pick<RuntimeLimits, "modelFileBytes">,
): FileView {
  const size = mediaReferenceOf(part.reference)?.size;
  if (size !== undefined && size > limits.modelFileBytes)
    return note(`it is larger than the ${limits.modelFileBytes} bytes a model call carries`);
  if (isText(part.mediaType)) return { kind: "text" };
  const inputs: readonly ModelInput[] = model?.inputs ?? FALLBACK_INPUTS;
  const kind = modelInputOf(part.mediaType);
  if (kind === undefined) return note(`no model reads ${essence(part.mediaType)} files`);
  if (!inputs.includes(kind)) return note(`this model does not read ${inputLabel(kind)}`);
  if (kind === "image" && !isModelImage(part.mediaType))
    return note("the model reads PNG, JPEG, GIF and WebP images only");
  return { kind: "media" };
}

const note = (why: string): FileView => ({ kind: "note", why });

/** A text file as the model reads it. `type` is the media type without parameters. */
export function fileBlock(name: string, type: string, text: string): string {
  return `<file name=${JSON.stringify(name)} type=${JSON.stringify(type)}>\n${text}\n</file>`;
}

/** Why the model does not see a file, in the prompt where the file would be. */
export function fileNote(name: string, type: string, why: string): string {
  return `(File ${JSON.stringify(name)}, ${type}, is not shown: ${why}.)`;
}

/**
 * The line a file stands for in a prompt (protocol 12): its name, artifact id and version, and
 * how the model reads it again. A file a tool returned names the tool. Every file is its line
 * once its turn is over; in its own turn the line labels what follows it.
 */
export function mediaReferenceLine(
  part: FilePart,
  origin: "uploaded" | { readonly tool: string },
): string {
  const reference = mediaReferenceOf(part.reference);
  const what =
    origin === "uploaded" ? "Uploaded artifact" : `Tool ${origin.tool} returned artifact`;
  if (!reference) return `[${what} (${part.mediaType})]`;
  const name = JSON.stringify(reference.name ?? reference.artifactId);
  return `[${what} ${name} · ${reference.artifactId} v${reference.version} · read_artifact to view]`;
}

/** A file of the turn in progress: its key (artifact and version), reference line and part. */
export interface LiveFile {
  readonly key: string;
  readonly line: string;
  readonly part: FilePart;
}

/** The key a file goes by in one call: its artifact version, or its reference. */
export function fileKeyOf(part: FilePart): string {
  const reference = mediaReferenceOf(part.reference);
  return reference
    ? `${reference.artifactId}@${reference.version}`
    : JSON.stringify(part.reference);
}

/**
 * What each live file becomes in the model call, by key: the media part, a `<file>` block, or
 * a note. Text is read over the artifact seam, strictly as UTF-8, and inlined while the files
 * inlined so far stay within `limits.modelCallBytes`; past it a file is a note. Without a
 * context (a local run), every file goes as its media part and the adapter decides.
 */
export async function representFiles(
  files: readonly LiveFile[],
  context: FileContext | undefined,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly PromptContentPart[]>> {
  const out = new Map<string, readonly PromptContentPart[]>();
  let inlined = 0;
  for (const file of files) {
    if (out.has(file.key)) continue;
    const view: FileView = context
      ? fileView(file.part, context.model, context.limits)
      : { kind: "media" };
    if (view.kind === "media") {
      out.set(file.key, [mediaPart(file.part)]);
      continue;
    }
    if (view.kind === "note") {
      out.set(file.key, [textPart(noteFor(file.part, view.why))]);
      continue;
    }
    const read = await readText(
      file.part,
      context!,
      context!.limits.modelCallBytes - inlined,
      signal,
    );
    if (read.kind === "note") {
      out.set(file.key, [textPart(fileNote(read.name, read.type, read.why))]);
      continue;
    }
    inlined += read.bytes;
    out.set(file.key, [textPart(fileBlock(read.name, read.type, read.text))]);
  }
  return out;
}

type TextRead =
  | {
      readonly kind: "text";
      readonly name: string;
      readonly type: string;
      readonly text: string;
      readonly bytes: number;
    }
  | { readonly kind: "note"; readonly name: string; readonly type: string; readonly why: string };

/** A text file's bytes, a chunk at a time, decoded strictly; or why it cannot be inlined. */
async function readText(
  part: FilePart,
  context: FileContext,
  room: number,
  signal: AbortSignal | undefined,
): Promise<TextRead> {
  const reference = mediaReferenceOf(part.reference);
  let name = reference?.name ?? reference?.artifactId ?? "file";
  let type = essence(part.mediaType);
  const refused = (why: string): TextRead => ({ kind: "note", name, type, why });
  if (!reference) return refused("it is not an artifact this harness can read");
  const { modelFileBytes, chunkBytes } = context.limits;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    for (;;) {
      const chunk = await context.read(reference, offset, chunkBytes, signal);
      name = chunk.artifact.name;
      type = essence(chunk.artifact.contentType);
      if (chunk.artifact.kind !== "file") return refused("it is a folder");
      if (chunk.artifact.size > modelFileBytes)
        return refused(`it is larger than the ${modelFileBytes} bytes a model call carries`);
      if (chunk.artifact.size > room)
        return refused(
          `inlined with this turn's other files, it would pass the ${context.limits.modelCallBytes} bytes a model call carries`,
        );
      if (chunk.bytes.byteLength > 0) chunks.push(chunk.bytes);
      offset += chunk.bytes.byteLength;
      if (chunk.eof || chunk.bytes.byteLength === 0) break;
    }
  } catch (error) {
    if (!(error instanceof HarnessApiError)) throw error;
    return refused(error.message.replace(/\.$/u, ""));
  }
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text", name, type, text, bytes: offset };
  } catch {
    return refused("it is not UTF-8 text");
  }
}

/** A note for a file decided before it was read: named by its reference. */
function noteFor(part: FilePart, why: string): string {
  const reference = mediaReferenceOf(part.reference);
  return fileNote(reference?.name ?? reference?.artifactId ?? "file", essence(part.mediaType), why);
}

function mediaPart(part: FilePart): PromptContentPart {
  return Object.freeze({
    type: "media" as const,
    mediaType: part.mediaType,
    reference: copyJson(part.reference),
  });
}

function textPart(text: string): PromptContentPart {
  return Object.freeze({ type: "text" as const, text });
}
