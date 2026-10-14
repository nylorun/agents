/**
 * Native file blocks (multimodal messages, M4): a PDF, an office document, audio or video the
 * model reads, carried to the provider in its own block. pi-ai's messages hold only text and
 * images, so a file goes in as a marker text part (`add`), which pi-ai never merges or escapes,
 * and the provider payload pi-ai builds is rewritten before it is sent (`rewrite`, from the
 * call's `onPayload`): each marker block becomes the API's native block. Images never come
 * here: pi-ai carries them itself.
 *
 * One instance serves one model call. pi-ai builds the payload again on every attempt, so
 * `rewrite` can run more than once; each run sets `error` afresh. A file whose kind or format
 * the API has no block for, an API with no rewriter, or a marker left in the payload (pi-ai
 * folded it into a longer string, or dropped it) is `error`: the call fails with it rather than
 * sending a marker to the model.
 */
import { randomUUID } from "node:crypto";
import type { TextContent } from "@earendil-works/pi-ai";
import { essence } from "../artifacts/media-types.js";
import { NATIVE_INPUTS } from "./capabilities.js";

/** The kinds of file a native block carries; images are pi-ai's own. */
export type NativeFileKind = "pdf" | "office" | "audio" | "video";

/** A file for one model call: its kind, media type, name and base64 bytes. */
export interface NativeFile {
  readonly kind: NativeFileKind;
  readonly mediaType: string;
  readonly name: string;
  /** The bytes, base64-encoded. */
  readonly data: string;
}

/**
 * The kinds each pi-ai API has a native block for here: the model inputs an operator may add
 * (`NATIVE_INPUTS`), images aside, so the two tables never disagree.
 */
export const NATIVE_FILE_KINDS: Readonly<Record<string, readonly NativeFileKind[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(NATIVE_INPUTS).map(([api, inputs]) => [
      api,
      Object.freeze(inputs.filter((input): input is NativeFileKind => input !== "text" && input !== "image")),
    ]),
  ),
);

/** The kinds of file `api` carries in a native block; none for an API without a rewriter. */
export function nativeKindsOf(api: string): readonly NativeFileKind[] {
  return Object.hasOwn(NATIVE_FILE_KINDS, api) ? NATIVE_FILE_KINDS[api]! : [];
}

const MARKER = /^\[\[nylorun-file:([0-9a-f-]{36})\]\]$/;
const MARKER_ANYWHERE = /\[\[nylorun-file:[0-9a-f-]{36}\]\]/;

type Block = Record<string, unknown>;
/** A marker block's text when `block` is one in this API's shape, else undefined. */
type MarkerText = (block: Block) => unknown;
/** The native block for `file`, given the marker block it replaces; a string is why not. */
type Native = (file: NativeFile, block: Block) => Block | string;

const dataUrl = (file: NativeFile) => `data:${essence(file.mediaType)};base64,${file.data}`;
/** `cache_control` the marker block carried (pi-ai marks the last block of a request). */
const cacheOf = (block: Block): Block =>
  block.cache_control === undefined ? {} : { cache_control: block.cache_control };
const textOfType = (type: string): MarkerText => (block) =>
  block.type === type ? block.text : undefined;

/** `input_audio.format` for a media type: OpenAI Chat Completions takes WAV and MP3 only. */
function audioFormat(mediaType: string): "wav" | "mp3" | undefined {
  switch (essence(mediaType)) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    default:
      return undefined;
  }
}

const anthropic: Native = (file, block) => ({
  type: "document",
  source: { type: "base64", media_type: essence(file.mediaType), data: file.data },
  title: file.name,
  ...cacheOf(block),
});

const responses: Native = (file) => ({
  type: "input_file",
  filename: file.name,
  file_data: dataUrl(file),
});

const completions: Native = (file, block) => {
  switch (file.kind) {
    case "pdf":
      return { type: "file", file: { filename: file.name, file_data: dataUrl(file) }, ...cacheOf(block) };
    case "audio": {
      const format = audioFormat(file.mediaType);
      if (!format) return "this API reads WAV and MP3 audio only";
      return { type: "input_audio", input_audio: { data: file.data, format }, ...cacheOf(block) };
    }
    default:
      return { type: "video_url", video_url: { url: dataUrl(file) }, ...cacheOf(block) };
  }
};

const google: Native = (file) => ({
  inlineData: { mimeType: essence(file.mediaType), data: file.data },
});

const REWRITERS: Readonly<Record<string, { readonly marker: MarkerText; readonly native: Native }>> = {
  "anthropic-messages": { marker: textOfType("text"), native: anthropic },
  "openai-responses": { marker: textOfType("input_text"), native: responses },
  "azure-openai-responses": { marker: textOfType("input_text"), native: responses },
  "openai-completions": { marker: textOfType("text"), native: completions },
  "google-generative-ai": { marker: (block) => (block.type === undefined ? block.text : undefined), native: google },
  "google-vertex": { marker: (block) => (block.type === undefined ? block.text : undefined), native: google },
};

const isBlock = (value: unknown): value is Block =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class NativeBlocks {
  private readonly files = new Map<string, NativeFile>();

  /** Why the last `rewrite` could not carry every file; undefined when it did. */
  error?: string;

  /** How many files this call carries. */
  get size(): number {
    return this.files.size;
  }

  /** A text part standing for `file` in pi-ai's context, replaced by `rewrite`. */
  add(file: NativeFile): TextContent {
    const id = randomUUID();
    this.files.set(id, file);
    return { type: "text", text: `[[nylorun-file:${id}]]` };
  }

  /**
   * `payload` (an `onPayload` request body for `api`) with each marker block replaced by its
   * native block. Rewrites in place and returns the same payload; sets `error` when a file
   * could not be carried.
   */
  rewrite(payload: unknown, api: string): unknown {
    this.error = undefined;
    if (this.files.size === 0) return payload;
    const rewriter = Object.hasOwn(REWRITERS, api) ? REWRITERS[api]! : undefined;
    if (!rewriter) {
      this.error = `The model's API (${api}) cannot carry files other than images`;
      return payload;
    }
    const kinds = nativeKindsOf(api);
    const placed = new Set<string>();
    let leftover = false;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const item = value[index];
          const replaced = isBlock(item) ? this.replace(item, rewriter, kinds, api) : undefined;
          if (replaced) {
            value[index] = replaced.block;
            placed.add(replaced.id);
          } else visit(item);
        }
      } else if (isBlock(value)) {
        for (const item of Object.values(value)) visit(item);
      } else if (typeof value === "string" && MARKER_ANYWHERE.test(value)) {
        leftover = true;
      }
    };
    visit(payload);
    if (this.error) return payload;
    if (leftover || placed.size < this.files.size) {
      const missing = [...this.files].find(([id]) => !placed.has(id))?.[1];
      this.error = missing
        ? `File "${missing.name}" did not reach the ${api} request as its own block`
        : `A file marker was left in the ${api} request`;
    }
    return payload;
  }

  /** The native block for a marker block of ours; undefined for any other block. */
  private replace(
    block: Block,
    rewriter: { readonly marker: MarkerText; readonly native: Native },
    kinds: readonly NativeFileKind[],
    api: string,
  ): { id: string; block: Block } | undefined {
    const text = rewriter.marker(block);
    if (typeof text !== "string") return undefined;
    const id = MARKER.exec(text)?.[1];
    const file = id === undefined ? undefined : this.files.get(id);
    if (!file) return undefined;
    const refuse = (reason: string) => {
      this.error ??= `File "${file.name}" (${essence(file.mediaType)}) cannot be sent to ${api}: ${reason}`;
      return undefined;
    };
    if (!kinds.includes(file.kind)) return refuse(`this API has no block for ${file.kind} files`);
    const native = rewriter.native(file, block);
    if (typeof native === "string") return refuse(native);
    return { id: id!, block: native };
  }
}
