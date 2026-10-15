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
