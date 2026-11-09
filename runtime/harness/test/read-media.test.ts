/**
 * `read` of a sandbox file the model reads as media (ADR-139): our engine reads the bytes, stores
 * them for the model only (`audience: "model"`) and answers with the file; a model that can't read
 * the kind, a file that isn't what its name says, and a missing file fail in words.
 */
import { describe, expect, it } from "vitest";
import {
  HarnessApiError,
  RUNTIME_LIMIT_DEFAULTS,
  fromBase64,
  memoryChannels,
  type ArtifactMeta,
  type ModelDescriptor,
  type ParamsOf,
} from "@nylorun/core/harness-api";
import { mediaReadOf, runMediaRead } from "../src/tools/read-media.js";
import type { HarnessFiles, HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%…");

/** A core that stores what `artifact.write` sends, keyed as the Runtime does. */
function fakeCore(options: { refuse?: boolean } = {}) {
  const { harness, core } = memoryChannels({ json: true });
  const begins: Extract<ParamsOf<"artifact.write">, { op: "begin" }>[] = [];
  const keys = new Map<string, ArtifactMeta>();
  core.handle(async (method, params) => {
    if (method !== "artifact.write") throw new Error(`unexpected ${method}`);
    const write = params as ParamsOf<"artifact.write">;
    if (write.op !== "begin" || write.base64 === undefined) throw new Error("whole bodies only");
    const known = keys.get(write.key);
    if (known) return { status: "written", artifact: known, created: false };
    if (options.refuse)
      throw new HarnessApiError(
        "limit_exceeded",
        "The Tenant's artifacts are full (limitBytes 10)",
      );
    begins.push(write);
    const meta: ArtifactMeta = {
      artifactId: `af_${begins.length}`,
      kind: "file",
      name: write.name ?? "?",
      version: 1,
      contentType: write.contentType ?? "application/octet-stream",
      size: fromBase64(write.base64).byteLength,
      sha256: "0".repeat(64),
      tenantWide: false,
    };
    keys.set(write.key, meta);
    return { status: "written", artifact: meta, created: true };
  });
  return { channel: harness, begins };
}

function sandboxFiles(files: Record<string, Uint8Array>): HarnessFiles & { reads: number } {
  const port = {
    reads: 0,
    async read(_run: HarnessRun, path: string, maxBytes: number) {
      port.reads += 1;
      const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
      const bytes = files[resolved];
      if (!bytes) return { kind: "missing" as const, path: resolved };
      if (bytes.byteLength > maxBytes)
        return {
          kind: "failed" as const,
          code: "artifact.too_large",
          message: `${resolved} is too large`,
        };
      return { kind: "read" as const, path: resolved, bytes };
    },
    async write() {
      throw new Error("not written");
    },
    async list() {
      throw new Error("not listed");
    },
    async mount() {
      throw new Error("not mounted");
    },
  };
  return port as unknown as HarnessFiles & { reads: number };
}

const reads = (inputs: ModelDescriptor["inputs"]): ModelDescriptor =>
  ({ provider: "test", model: "m", inputs }) as unknown as ModelDescriptor;

const run = (model?: ModelDescriptor): HarnessRun => ({
  runId: "r1",
  grant: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1 },
  start: {
    ...(model ? { model } : {}),
    limits: RUNTIME_LIMIT_DEFAULTS,
    routing: { rootManifest: { id: "bot" } },
    agent: { id: "env", kind: "virtual", sandbox: { workspace: "/workspace" } },
  } as unknown as HarnessRun["start"],
  signal: new AbortController().signal,
});

const readCall = (path: string, effectId = "t1:0:tool:c1"): HostEffect => ({
  effectId,
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  kind: "tool",
  toolName: "read",
  target: { kind: "sandbox" },
  input: { path },
  context: { callId: "c1", invocationId: "i1" },
});

async function media(
  path: string,
  files: Record<string, Uint8Array>,
  model?: ModelDescriptor,
  core = fakeCore(),
) {
  const effect = readCall(path);
  const target = mediaReadOf(effect);
  if (!target) throw new Error(`${path} is not a media read`);
  const sandbox = sandboxFiles(files);
  const outcome = await runMediaRead(effect, target, {
    channel: core.channel,
    run: run(model),
    files: sandbox,
    signal: new AbortController().signal,
  });
  return { outcome, core, sandbox };
}

describe("mediaReadOf", () => {
  it("takes reads of files a model reads as media, and leaves text to the sandbox", () => {
    expect(mediaReadOf(readCall("figure.png"))).toEqual({
      path: "figure.png",
      contentType: "image/png",
    });
    expect(mediaReadOf(readCall("/workspace/out/q3.pdf"))).toEqual({
      path: "/workspace/out/q3.pdf",
      contentType: "application/pdf",
    });
    expect(mediaReadOf(readCall("deck.pptx"))?.contentType).toContain("presentationml");
    for (const path of ["notes.md", "page.html", "logo.svg", "data.parquet", "Makefile"])
      expect(mediaReadOf(readCall(path))).toBeUndefined();
    // Only the sandbox's own read.
    expect(mediaReadOf({ ...readCall("a.png"), toolName: "write" })).toBeUndefined();
    expect(mediaReadOf({ ...readCall("a.png"), target: { kind: "harness" } })).toBeUndefined();
  });
});

describe("runMediaRead", () => {
  it("shows an image to a model that reads images, stored for the model only", async () => {
    const { outcome, core } = await media(
      "figure.png",
      { "/workspace/figure.png": PNG },
      reads(["text", "image"]),
    );
    expect(outcome).toEqual({
      kind: "completed",
      output: { path: "/workspace/figure.png", contentType: "image/png", size: PNG.byteLength },
      files: [
        {
          mediaType: "image/png",
          reference: { artifactId: "af_1", version: 1, name: "figure.png", size: PNG.byteLength },
        },
      ],
    });
    expect(core.begins).toHaveLength(1);
    expect(core.begins[0]).toMatchObject({
      key: "t1:0:tool:c1",
      effectId: "t1:0:tool:c1",
      name: "figure.png",
      contentType: "image/png",
      audience: "model",
    });
  });

  it("shows a PDF to a model that reads PDFs", async () => {
    const { outcome } = await media(
      "q3.pdf",
      { "/workspace/q3.pdf": PDF },
      reads(["text", "image", "pdf"]),
    );
    expect(outcome).toMatchObject({ kind: "completed", files: [{ mediaType: "application/pdf" }] });
  });

  it("fails in words on a model that can't read the kind, before reading or storing", async () => {
    const { outcome, core, sandbox } = await media(
      "q3.pdf",
      { "/workspace/q3.pdf": PDF },
      reads(["text", "image"]),
    );
    expect(outcome).toMatchObject({ kind: "failed", code: "sandbox.unreadable" });
    expect((outcome as { message: string }).message).toContain("this model does not read PDFs");
    expect(sandbox.reads).toBe(0);
    expect(core.begins).toHaveLength(0);
  });

  it("refuses a file that doesn't start like its type, storing nothing", async () => {
    const fake = new TextEncoder().encode("not really a png");
    const { outcome, core } = await media(
      "logo.png",
      { "/workspace/logo.png": fake },
      reads(["text", "image"]),
    );
    expect(outcome).toMatchObject({ kind: "failed", code: "sandbox.binary_file" });
    expect(core.begins).toHaveLength(0);
  });

  it("says when there is no such file", async () => {
    const { outcome } = await media("gone.png", {}, reads(["text", "image"]));
    expect(outcome).toEqual({
      kind: "failed",
      code: "sandbox.not_found",
      message: "No file at /workspace/gone.png",
    });
  });

  it("tells the model when the Tenant's artifacts are full", async () => {
    const { outcome } = await media(
      "figure.png",
      { "/workspace/figure.png": PNG },
      reads(["text", "image"]),
      fakeCore({ refuse: true }),
    );
    expect(outcome).toMatchObject({ kind: "failed", code: "sandbox.too_large" });
  });

  it("answers a repeated call with the version it stored", async () => {
    const core = fakeCore();
    const first = await media(
      "figure.png",
      { "/workspace/figure.png": PNG },
      reads(["text", "image"]),
      core,
    );
    const again = await media(
      "figure.png",
      { "/workspace/figure.png": PNG },
      reads(["text", "image"]),
      core,
    );
    expect(again.outcome).toEqual(first.outcome);
    expect(core.begins).toHaveLength(1);
  });
});
