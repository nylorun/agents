/**
 * Media types of file artifacts (`utils/media-types.ts`): what the Runtime stores and what a
 * harness reads over the artifact seam are typed by the same functions.
 */
import { expect, it } from "vitest";
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeFor,
  extensionFor,
  isOffice,
  isText,
  matchesSignature,
  modelInputOf,
  normalizeContentType,
} from "../src/contracts.js";

it("tells which input a file is", () => {
  expect(modelInputOf("text/csv; charset=utf-8")).toBe("text");
  expect(modelInputOf("application/json")).toBe("text");
  // SVG is XML: the model reads it as text.
  expect(modelInputOf("image/svg+xml")).toBe("text");
  expect(modelInputOf("image/bmp")).toBe("image");
  expect(modelInputOf("application/pdf")).toBe("pdf");
  expect(modelInputOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("office");
  expect(modelInputOf("audio/mpeg")).toBe("audio");
  expect(modelInputOf("video/mp4")).toBe("video");
  expect(modelInputOf("application/zip")).toBeUndefined();

  expect(isOffice("application/vnd.ms-excel; x=1")).toBe(true);
  expect(isOffice("application/pdf")).toBe(false);
});

it("types a file by its name, and checks a declared media type", () => {
  expect(contentTypeFor("report.PDF")).toBe("application/pdf");
  expect(contentTypeFor("notes.md")).toBe("text/markdown");
  expect(contentTypeFor("README")).toBe(DEFAULT_CONTENT_TYPE);
  expect(contentTypeFor("archive.unknown")).toBe(DEFAULT_CONTENT_TYPE);
  expect(extensionFor("image/png; x=1")).toBe("png");
  expect(normalizeContentType(" text/plain; charset=utf-8 ")).toBe("text/plain; charset=utf-8");
  expect(normalizeContentType("not a type")).toBeUndefined();
  expect(normalizeContentType("")).toBeUndefined();
  expect(isText("application/ld+json")).toBe(true);
  expect(isText("image/png")).toBe(false);
});

it("checks a file's first bytes against its type (ADR-139)", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(values.flatMap((value) => (typeof value === "string" ? [...value].map((c) => c.charCodeAt(0)) : [value])));
  expect(matchesSignature("image/png", bytes(0x89, "PNG\r\n", 0x1a, 0x0a, 0, 0))).toBe(true);
  expect(matchesSignature("image/png", bytes("not a png"))).toBe(false);
  expect(matchesSignature("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
  expect(matchesSignature("image/gif", bytes("GIF89a"))).toBe(true);
  expect(matchesSignature("image/webp", bytes("RIFF", 1, 2, 3, 4, "WEBPVP8"))).toBe(true);
  expect(matchesSignature("image/webp", bytes("RIFF", 1, 2, 3, 4, "WAVE"))).toBe(false);
  expect(matchesSignature("application/pdf", bytes("%PDF-1.7"))).toBe(true);
  expect(matchesSignature(contentTypeFor("deck.pptx"), bytes("PK", 3, 4, 0))).toBe(true);
  expect(matchesSignature("application/msword", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(true);
  // Too short to hold the signature, and a type without one.
  expect(matchesSignature("image/png", bytes(0x89))).toBe(false);
  expect(matchesSignature("audio/mpeg", bytes("ID3"))).toBeUndefined();
});
