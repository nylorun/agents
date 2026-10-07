/**
 * Media types of file artifacts: what an upload may declare, what a name's extension implies,
 * and how the model reads a file (an image as an image, text as text, anything else refused).
 */
import { DEFAULT_CONTENT_TYPE } from "../blob/index.js";

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
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

/** The largest image or text file a model call carries inline. */
export const MODEL_FILE_MAX_BYTES = 8 * 1024 * 1024;

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
