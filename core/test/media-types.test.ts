/**
 * Media types of file artifacts (`utils/media-types.ts`): what the Runtime stores and what a
 * harness reads over the artifact seam are typed by the same functions.
 */
import { expect, it } from "vitest";
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeFor,
  extensionFor,
  isText,
  modelInputOf,
  normalizeContentType,
  unreadableReason,
} from "../src/contracts.js";

it("tells which input a file is, and why a model cannot read one", () => {
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

  const inputs = ["text", "image"] as const;
  expect(unreadableReason("text/plain", ["text"])).toBeUndefined();
  expect(unreadableReason("image/png", inputs)).toBeUndefined();
  expect(unreadableReason("image/png", ["text"])).toBe("this model does not read images");
  expect(unreadableReason("image/bmp", inputs)).toBe("the model reads PNG, JPEG, GIF and WebP images only");
  expect(unreadableReason("application/pdf", inputs)).toBe("this model does not read PDFs");
  expect(unreadableReason("application/zip", inputs)).toBe("no model reads application/zip files");
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
