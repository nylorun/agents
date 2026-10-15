/**
 * Media types of file artifacts: what an upload may declare, what a name's extension implies,
 * and which model input a file is (`modelInputOf`, protocol 12): text, an image, a PDF, an Office
 * document, audio or video. A model reads a file only when its inputs include that one. The
 * Runtime types what it stores with these, and a harness what it reads and writes over the
 * Harness API's artifact seam (protocol 15), so both agree.
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

/** A declared `Content-Type` as stored, or undefined when it is not a media type. */
export function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 255) return undefined;
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
function isOffice(type: string): boolean {
  return (
    type === "application/msword" ||
    type === "application/vnd.ms-excel" ||
    type === "application/vnd.ms-powerpoint" ||
    type.startsWith("application/vnd.openxmlformats-officedocument.")
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

/**
 * Why a model that reads `inputs` cannot read a file of `contentType`, or undefined when it can.
 * An image must also be PNG, JPEG, GIF or WebP.
 */
export function unreadableReason(
  contentType: string,
  inputs: readonly ModelInput[],
): string | undefined {
  const input = modelInputOf(contentType);
  if (input === undefined) return `no model reads ${essence(contentType)} files`;
  if (!inputs.includes(input)) return `this model does not read ${LABELS[input]}`;
  if (input === "image" && !isModelImage(contentType))
    return "the model reads PNG, JPEG, GIF and WebP images only";
  return undefined;
}
