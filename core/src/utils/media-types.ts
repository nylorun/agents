/**
 * Media types of file artifacts: what an upload may declare, what a name's extension implies,
 * and which model input a file is (`modelInputOf`, protocol 12): text, an image, a PDF, an Office
 * document, audio or video. A model reads a file only when its inputs include that one. The
 * Runtime types what it stores with these, a harness what it reads and writes over the Harness
 * API's artifact seam and how it shows a file to the model, and the Model Gate what it refuses
 * (protocol 15), so all three agree.
 */
import type { ModelInput } from "../contracts.js";

/** The media type of bytes nothing says more about. */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  py: "text/x-python",
  sh: "text/x-sh",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};

/** Images the model reads as images. */
export const MODEL_IMAGE_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** The type part of a `Content-Type` value, lowercased, without parameters. */
export function essence(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/**
 * The longest `Content-Type` kept, its parameters included: RFC 6838 §4.2's type and subtype of at
 * most 127 characters each and the slash between them. A standard's constant.
 */
const MEDIA_TYPE_MAX = 127 + 1 + 127;

/** A declared `Content-Type` as stored, or undefined when it is not a media type. */
export function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MEDIA_TYPE_MAX) return undefined;
  return MEDIA_TYPE.test(essence(trimmed)) ? trimmed : undefined;
}

/** The media type a file name implies, or `application/octet-stream`. */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return DEFAULT_CONTENT_TYPE;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

export function isModelImage(contentType: string): boolean {
  return MODEL_IMAGE_TYPES.includes(essence(contentType));
}

/** Files the model reads as text: `text/*`, JSON, XML, YAML and their `+json`/`+xml` kin. */
export function isText(contentType: string): boolean {
  const type = essence(contentType);
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/yaml" ||
    type === "application/x-yaml" ||
    type === "application/javascript" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** The usual extension of a media type, for a name the Runtime gives a file; undefined if none. */
export function extensionFor(contentType: string): string | undefined {
  const type = essence(contentType);
  return Object.keys(BY_EXTENSION).find((extension) => BY_EXTENSION[extension] === type);
}

/** Word, Excel and PowerPoint documents, old and Open XML. */
export function isOffice(contentType: string): boolean {
  const type = essence(contentType);
  return (
    type === "application/msword" ||
    type === "application/vnd.ms-excel" ||
    type === "application/vnd.ms-powerpoint" ||
    type.startsWith("application/vnd.openxmlformats-officedocument.")
  );
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** The first bytes a file of each type starts with, where the type has one. */
const SIGNATURES: Readonly<Record<string, readonly (readonly (number | undefined)[])[]>> = {
  "image/png": [[0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [ascii("GIF87a"), ascii("GIF89a")],
  // RIFF, four bytes of size, then WEBP.
  "image/webp": [[...ascii("RIFF"), undefined, undefined, undefined, undefined, ...ascii("WEBP")]],
  "application/pdf": [ascii("%PDF-")],
  // Old Office files are OLE compound documents; Open XML ones are zip archives.
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  "application/vnd.ms-powerpoint": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
};
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * Whether `bytes` start as a file of `contentType` does: true or false for a type with a known
 * signature (PNG, JPEG, GIF, WebP, PDF, Office), undefined for one without. A sandbox file is typed
 * by its extension; this keeps a `.png` that isn't a PNG from reaching a model as an image.
 */
export function matchesSignature(contentType: string, bytes: Uint8Array): boolean | undefined {
  const type = essence(contentType);
  const signatures =
    SIGNATURES[type] ?? (type.startsWith("application/vnd.openxmlformats-officedocument.") ? [ZIP] : undefined);
  if (signatures === undefined) return undefined;
  return signatures.some(
    (signature) =>
      bytes.byteLength >= signature.length &&
      signature.every((byte, index) => byte === undefined || bytes[index] === byte),
  );
}

/** The model input a file of `contentType` is, or undefined for a type no model reads. */
export function modelInputOf(contentType: string): ModelInput | undefined {
  const type = essence(contentType);
  if (isText(type)) return "text";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (isOffice(type)) return "office";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return undefined;
}

const LABELS: Readonly<Record<ModelInput, string>> = {
  text: "text files",
  image: "images",
  pdf: "PDFs",
  office: "Office documents",
  audio: "audio",
  video: "video",
};

/** An input, in a sentence: "PDFs", "Office documents"; "files of this type" for none. */
export function inputLabel(input: ModelInput | undefined): string {
  return input === undefined ? "files of this type" : LABELS[input];
}
