/**
 * How our engine shows each file to the model (protocol 15, `loop/model/files.ts`): the
 * decision by the model descriptor and the Runtime limits, the exact text of a `<file>` block, a
 * note and a reference line, and text read over the artifact seam.
 */
import { describe, expect, it } from "vitest";
import {
  HarnessApiError,
  RUNTIME_LIMIT_DEFAULTS,
  type ArtifactMeta,
  type ModelDescriptor,
} from "@nylorun/core/harness-api";
import {
  fileBlock,
  fileNote,
  fileView,
  mediaReferenceLine,
  representFiles,
  type FileContext,
  type LiveFile,
} from "../src/index.js";

const limits = RUNTIME_LIMIT_DEFAULTS;
const model = (inputs: ModelDescriptor["inputs"]): ModelDescriptor => ({
  provider: "openai",
  id: "gpt",
  inputs,
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
});
const part = (mediaType: string, size = 10, name = "f") => ({
  mediaType,
  reference: { artifactId: `af_${name}`, version: 1, name, size },
});

describe("fileView", () => {
  const all = model(["text", "image", "pdf", "office", "audio", "video"]);
  const textOnly = model(["text"]);
  it.each([
    ["text/csv", all, { kind: "text" }],
    ["application/json", textOnly, { kind: "text" }],
    ["image/png", all, { kind: "media" }],
    [
      "image/bmp",
      all,
      { kind: "note", why: "the model reads PNG, JPEG, GIF and WebP images only" },
    ],
    ["image/png", textOnly, { kind: "note", why: "this model does not read images" }],
    ["application/pdf", all, { kind: "media" }],
    ["application/vnd.ms-excel", all, { kind: "media" }],
    ["audio/mpeg", all, { kind: "media" }],
    ["video/mp4", all, { kind: "media" }],
    ["application/pdf", textOnly, { kind: "note", why: "this model does not read PDFs" }],
    [
      "application/msword",
      textOnly,
      { kind: "note", why: "this model does not read Office documents" },
    ],
    ["audio/wav", textOnly, { kind: "note", why: "this model does not read audio" }],
    ["application/zip", all, { kind: "note", why: "no model reads application/zip files" }],
  ] as const)("shows %s to a model by its inputs", (type, descriptor, view) => {
    expect(fileView(part(type), descriptor, limits)).toEqual(view);
  });

  it("notes a file larger than the Runtime limit modelFileBytes, of any type", () => {
    for (const type of ["text/plain", "image/png", "application/pdf"])
      expect(fileView(part(type, 101), all, { modelFileBytes: 100 })).toEqual({
        kind: "note",
        why: "it is larger than the 100 bytes a model call carries",
      });
    expect(fileView(part("image/png", 100), all, { modelFileBytes: 100 })).toEqual({
      kind: "media",
    });
  });

  it("takes a model with no descriptor to read text and images", () => {
    expect(fileView(part("image/jpeg"), undefined, limits)).toEqual({ kind: "media" });
    expect(fileView(part("text/plain"), undefined, limits)).toEqual({ kind: "text" });
    expect(fileView(part("application/pdf"), undefined, limits)).toEqual({
      kind: "note",
      why: "this model does not read PDFs",
    });
  });
});

describe("the text the model reads", () => {
  it("writes a file block, a note and a reference line exactly", () => {
    expect(fileBlock('a "b".csv', "text/csv", "x,y")).toBe(
      '<file name="a \\"b\\".csv" type="text/csv">\nx,y\n</file>',
    );
    expect(fileNote("a.zip", "application/zip", "no model reads application/zip files")).toBe(
      '(File "a.zip", application/zip, is not shown: no model reads application/zip files.)',
    );
    const shot = {
      mediaType: "image/png",
      reference: { artifactId: "af_1", version: 2, name: "s.png" },
    };
    expect(mediaReferenceLine(shot, "uploaded")).toBe(
      '[Uploaded artifact "s.png" · af_1 v2 · read_artifact to view]',
    );
    expect(mediaReferenceLine(shot, { tool: "screenshot" })).toBe(
      '[Tool screenshot returned artifact "s.png" · af_1 v2 · read_artifact to view]',
    );
    // Another host's reference has no line of ours.
    expect(mediaReferenceLine({ mediaType: "image/png", reference: "blob:1" }, "uploaded")).toBe(
      "[Uploaded artifact (image/png)]",
    );
  });
});

/** A seam over `files` by artifact id, in chunks of `chunkBytes`; reads are logged. */
function seam(
  files: Record<
    string,
    { bytes: Uint8Array; contentType: string; name?: string; kind?: "file" | "folder" }
  >,
  options: { model?: ModelDescriptor; limits?: Partial<typeof limits> } = {},
) {
  const reads: { artifactId: string; offset: number; length: number }[] = [];
  const context: FileContext = {
    ...(options.model ? { model: options.model } : {}),
    limits: { ...limits, ...options.limits },
    async read(reference, offset, length) {
      reads.push({ artifactId: reference.artifactId, offset, length });
      const file = files[reference.artifactId];
      if (!file)
        throw new HarnessApiError("not_found", `No artifact ${reference.artifactId} for this run.`);
      const artifact: ArtifactMeta = {
        artifactId: reference.artifactId,
        kind: file.kind ?? "file",
        name: file.name ?? reference.artifactId,
        version: reference.version,
        contentType: file.contentType,
        size: file.bytes.byteLength,
        sha256: "0".repeat(64),
        tenantWide: false,
      };
      const bytes = file.bytes.subarray(offset, offset + length);
      return { artifact, bytes, eof: offset + bytes.byteLength >= file.bytes.byteLength };
    },
  };
  return { context, reads };
}

const live = (key: string, mediaType: string, size: number, name = key): LiveFile => ({
  key,
  line: `[line ${key}]`,
  part: { mediaType, reference: { artifactId: key, version: 1, name, size } },
});

describe("representFiles", () => {
  const encoder = new TextEncoder();
  it("inlines text read in chunks, sends media as references, and notes the rest", async () => {
    const csv = encoder.encode("a,b\n1,2\n");
    const { context, reads } = seam(
      { csv: { bytes: csv, contentType: "text/csv; charset=utf-8", name: "data.csv" } },
      { model: model(["text", "image"]), limits: { chunkBytes: 3 } },
    );
    const files = [
      live("csv", "text/csv", csv.byteLength),
      live("png", "image/png", 5),
      live("zip", "application/zip", 5, "a.zip"),
    ];
    const shown = await representFiles(files, context);
    expect(shown.get("csv")).toEqual([
      { type: "text", text: '<file name="data.csv" type="text/csv">\na,b\n1,2\n\n</file>' },
    ]);
    expect(shown.get("png")).toEqual([
      { type: "media", mediaType: "image/png", reference: files[1]!.part.reference },
    ]);
    expect(shown.get("zip")).toEqual([
      {
        type: "text",
        text: '(File "a.zip", application/zip, is not shown: no model reads application/zip files.)',
      },
    ]);
    // Only the text file is read, a chunk at a time.
    expect(reads.map((read) => read.offset)).toEqual([0, 3, 6]);
    expect(reads.every((read) => read.artifactId === "csv" && read.length === 3)).toBe(true);
  });

  it("notes text that is not UTF-8, a refused read, a folder, and text past the call's room", async () => {
    const { context } = seam(
      {
        bin: {
          bytes: new Uint8Array([0xff, 0xfe, 0x00]),
          contentType: "text/plain",
          name: "bin.txt",
        },
        dir: { bytes: new Uint8Array(), contentType: "text/plain", kind: "folder" },
        big: { bytes: encoder.encode("x".repeat(60)), contentType: "text/plain" },
        next: { bytes: encoder.encode("y".repeat(60)), contentType: "text/plain" },
      },
      { limits: { modelCallBytes: 100 } },
    );
    const shown = await representFiles(
      [
        live("bin", "text/plain", 3),
        live("gone", "text/plain", 3),
        live("dir", "text/plain", 0),
        live("big", "text/plain", 60),
        live("next", "text/plain", 60),
      ],
      context,
    );
    const text = (key: string) => (shown.get(key)![0] as { text: string }).text;
    expect(text("bin")).toBe('(File "bin.txt", text/plain, is not shown: it is not UTF-8 text.)');
    expect(text("gone")).toBe(
      '(File "gone", text/plain, is not shown: No artifact gone for this run.)',
    );
    expect(text("dir")).toContain("is not shown: it is a folder.");
    expect(text("big")).toBe(fileBlock("big", "text/plain", "x".repeat(60)));
    expect(text("next")).toBe(
      '(File "next", text/plain, is not shown: inlined with this turn\'s other files, it would pass the 100 bytes a model call carries.)',
    );
  });

  it("sends every file as its media part without a context (a local run)", async () => {
    const files = [live("csv", "text/csv", 3), live("zip", "application/zip", 3)];
    const shown = await representFiles(files, undefined);
    expect([...shown.values()].map((parts) => parts[0]!.type)).toEqual(["media", "media"]);
  });

  it("throws what is not a refusal of the seam", async () => {
    const context: FileContext = {
      limits,
      async read() {
        throw new Error("channel closed");
      },
    };
    await expect(representFiles([live("csv", "text/csv", 3)], context)).rejects.toThrow(
      "channel closed",
    );
  });
});
