/**
 * Our engine's artifact tools (protocol 15): `read_artifact` and `save_artifact` run in the
 * harness over the artifact seam (`artifact.read`, `artifact.write`) and the run's sandbox files.
 * A core that serves the seam from memory stands in for the Runtime, over a JSON channel that
 * validates every frame.
 */
import { describe, expect, it } from "vitest";
import {
  HarnessApiError,
  RUNTIME_LIMIT_DEFAULTS,
  fromBase64,
  memoryChannels,
  toBase64,
  type ArtifactMeta,
  type HarnessChannel,
  type ModelDescriptor,
  type ParamsOf,
} from "@nylorun/core/harness-api";
import { runArtifactTool } from "../src/tools/artifacts.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";
import { engineConfig } from "./fixtures.js";
import { apiHost } from "../src/api/host.js";
import type { HarnessExecutors, HarnessFiles, HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";

interface Stored {
  readonly meta: ArtifactMeta;
  readonly bytes: Uint8Array;
}

const sha = "0".repeat(64);

function file(
  artifactId: string,
  name: string,
  contentType: string,
  text: string | Uint8Array,
): Stored {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return {
    meta: {
      artifactId,
      kind: "file",
      name,
      version: 1,
      contentType,
      size: bytes.byteLength,
      sha256: sha,
      tenantWide: false,
    },
    bytes,
  };
}

/** A core serving the seam for one session's artifacts, with what each request asked. */
function fakeCore(stored: Stored[], options: { maxBytes?: number } = {}) {
  const { harness, core } = memoryChannels({ json: true });
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const byId = new Map(stored.map((entry) => [entry.meta.artifactId, entry]));
  const keys = new Map<string, ArtifactMeta>();
  const uploads = new Map<
    string,
    { begin: Extract<ParamsOf<"artifact.write">, { op: "begin" }>; chunks: Uint8Array[] }
  >();
  const saved: { begin: Record<string, unknown>; bytes: Uint8Array }[] = [];
  const store = (
    begin: Extract<ParamsOf<"artifact.write">, { op: "begin" }>,
    bytes: Uint8Array,
  ): ArtifactMeta => {
    const meta: ArtifactMeta = {
      artifactId: begin.artifactId ?? `af_${saved.length + 1}`,
      kind: "file",
      name: begin.name ?? byId.get(begin.artifactId!)?.meta.name ?? "?",
      version: 1,
      contentType: begin.contentType ?? "application/octet-stream",
      size: bytes.byteLength,
      sha256: sha,
      tenantWide: false,
    };
    saved.push({ begin, bytes });
    keys.set(begin.key, meta);
    return meta;
  };
  core.handle(async (method, params) => {
    const p = params as Record<string, unknown>;
    requests.push({ method, params: p });
    if (method === "artifact.read") {
      const read = p as ParamsOf<"artifact.read">;
      const entry = byId.get(read.artifactId);
      if (!entry)
        throw new HarnessApiError(
          "not_found",
          `Artifact ${read.artifactId} is not an artifact of this session.`,
        );
      const offset = read.offset ?? 0;
      if (offset > entry.meta.size)
        throw new HarnessApiError("invalid", `Offset ${offset} is past the end`);
      const length = Math.min(
        read.length ?? RUNTIME_LIMIT_DEFAULTS.chunkBytes,
        RUNTIME_LIMIT_DEFAULTS.chunkBytes,
      );
      const bytes =
        entry.meta.kind === "file"
          ? entry.bytes.subarray(offset, offset + length)
          : new Uint8Array();
      return {
        artifact: entry.meta,
        offset,
        base64: toBase64(bytes),
        eof: offset + bytes.byteLength >= entry.meta.size,
      };
    }
    const write = p as ParamsOf<"artifact.write">;
    switch (write.op) {
      case "begin": {
        const known = keys.get(write.key);
        if (known) return { status: "written", artifact: known, created: false };
        if (write.base64 !== undefined) {
          const bytes = fromBase64(write.base64);
          if (bytes.byteLength > (options.maxBytes ?? Infinity))
            throw new HarnessApiError(
              "limit_exceeded",
              "A file may hold at most 4 bytes (limitBytes 4)",
            );
          return { status: "written", artifact: store(write, bytes), created: true };
        }
        uploads.set(write.key, { begin: write, chunks: [] });
        return {
          status: "open",
          uploadId: write.key,
          maxBytes: options.maxBytes ?? 1000,
          received: 0,
        };
      }
      case "chunk": {
        const upload = uploads.get(write.uploadId)!;
        upload.chunks.push(fromBase64(write.base64));
        const received = upload.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        return { status: "open", uploadId: write.uploadId, maxBytes: 1000, received };
      }
      case "commit": {
        const upload = uploads.get(write.uploadId)!;
        uploads.delete(write.uploadId);
        return {
          status: "written",
          artifact: store(upload.begin, new Uint8Array(Buffer.concat(upload.chunks))),
          created: true,
        };
      }
      case "abort":
        uploads.delete(write.uploadId);
        return { status: "aborted" };
    }
  });
  return { channel: harness, requests, saved, uploads };
}

/** A sandbox's files in memory. */
function sandboxFiles(files: Record<string, Uint8Array> = {}) {
  const written: Record<string, Uint8Array> = {};
  const reads: { path: string; maxBytes: number }[] = [];
  const port: HarnessFiles = {
    async read(_run, path, maxBytes) {
      reads.push({ path, maxBytes });
      const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
      const bytes = files[resolved];
      if (!bytes) return { kind: "missing", path: resolved };
      if (bytes.byteLength > maxBytes)
        return { kind: "failed", code: "artifact.too_large", message: `${resolved} is too large` };
      return { kind: "read", path: resolved, bytes };
    },
    async write(_run, path, body) {
      const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      written[resolved] = new Uint8Array(Buffer.concat(chunks));
      return { kind: "written", path: resolved, size: written[resolved]!.byteLength };
    },
  };
  return { port, written, reads };
}

const run = (
  options: { sandbox?: boolean; chunkBytes?: number; model?: ModelDescriptor } = {},
): HarnessRun => ({
  runId: "r1",
  grant: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1 },
  start: {
    ...(options.model ? { model: options.model } : {}),
    limits: {
      ...RUNTIME_LIMIT_DEFAULTS,
      chunkBytes: options.chunkBytes ?? RUNTIME_LIMIT_DEFAULTS.chunkBytes,
    },
    routing: { rootManifest: { id: "bot" } },
    ...(options.sandbox
      ? { agent: { id: "env", kind: "virtual", sandbox: { workspace: "/workspace" } } }
      : {}),
  } as unknown as HarnessRun["start"],
  signal: new AbortController().signal,
});

const call = (
  toolName: string,
  input: unknown,
  effectId = "t1:0:tool:c1",
  target: HostEffect["target"] = { kind: "harness" },
): HostEffect => ({
  effectId,
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  kind: "tool",
  toolName,
  target,
  input,
  context: { callId: "c1", invocationId: "i1" },
});

const tool = (
  channel: HarnessChannel,
  options: {
    files?: HarnessFiles;
    sandbox?: boolean;
    pageBytes?: number;
    chunkBytes?: number;
    model?: ModelDescriptor;
  } = {},
) => ({
  channel,
  run: run({
    sandbox: options.sandbox ?? options.files !== undefined,
    ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
    ...(options.model ? { model: options.model } : {}),
  }),
  ...(options.files ? { files: options.files } : {}),
  pageBytes: options.pageBytes ?? 32 * 1024,
  signal: new AbortController().signal,
});

describe("read_artifact", () => {
  it("reads a text page from an offset, with nextOffset while more remains", async () => {
    const core = fakeCore([file("af_t", "log.txt", "text/plain", "0123456789")]);
    const first = await runArtifactTool(
      call("read_artifact", { artifactId: "af_t", length: 4 }),
      tool(core.channel),
    );
    expect(first).toEqual({
      kind: "completed",
      output: {
        artifactId: "af_t",
        version: 1,
        name: "log.txt",
        contentType: "text/plain",
        size: 10,
        offset: 0,
        content: "0123",
        nextOffset: 4,
      },
    });
    const last = await runArtifactTool(
      call("read_artifact", { artifactId: "af_t", offset: 8 }),
      tool(core.channel),
    );
    expect(last).toMatchObject({ output: { offset: 8, content: "89" } });
    expect((last as { output: object }).output).not.toHaveProperty("nextOffset");
    // One seam request each, for the page asked.
    expect(core.requests.map((request) => request.params)).toEqual([
      { runId: "r1", artifactId: "af_t", offset: 0, length: 4 },
      { runId: "r1", artifactId: "af_t", offset: 8, length: 32 * 1024 },
    ]);
  });

  it("keeps whole UTF-8 characters, and holds a page to its bytes escaped as JSON", async () => {
    const core = fakeCore([
      file("af_u", "u.txt", "text/plain", "ab€cd"),
      file("af_q", "q.txt", "text/plain", '""""""""'),
    ]);
    // A page that ends inside "€" (3 bytes) stops before it; the next starts there.
    const cut = await runArtifactTool(
      call("read_artifact", { artifactId: "af_u", length: 3 }),
      tool(core.channel),
    );
    expect(cut).toMatchObject({ output: { content: "ab", nextOffset: 2 } });
    const on = await runArtifactTool(
      call("read_artifact", { artifactId: "af_u", offset: 2, length: 3 }),
      tool(core.channel),
    );
    expect(on).toMatchObject({ output: { content: "€", nextOffset: 5 } });
    // A page that starts inside a character skips its rest.
    const inside = await runArtifactTool(
      call("read_artifact", { artifactId: "af_u", offset: 3 }),
      tool(core.channel),
    );
    expect(inside).toMatchObject({ output: { content: "cd" } });
    // Each quote takes two bytes escaped: a 10-byte page holds four of them and its quotes.
    const quotes = await runArtifactTool(
      call("read_artifact", { artifactId: "af_q" }),
      tool(core.channel, { pageBytes: 10 }),
    );
    expect(quotes).toMatchObject({ output: { content: '""""', nextOffset: 4 } });
  });

  it("shows another file to the model as a file of the result", async () => {
    const core = fakeCore([file("af_p", "chart.png", "image/png", new Uint8Array([1, 2, 3]))]);
    const outcome = await runArtifactTool(
      call("read_artifact", { artifactId: "af_p", version: 1 }),
      tool(core.channel),
    );
    expect(outcome).toEqual({
      kind: "completed",
      output: {
        artifactId: "af_p",
        version: 1,
        name: "chart.png",
        contentType: "image/png",
        size: 3,
      },
      files: [
        {
          mediaType: "image/png",
          reference: { artifactId: "af_p", version: 1, name: "chart.png", size: 3 },
        },
      ],
    });
  });

  it("refuses a file the turn's model does not read, by its descriptor (protocol 15)", async () => {
    const core = fakeCore([
      file("af_p", "chart.png", "image/png", new Uint8Array([1, 2, 3])),
      file("af_d", "spec.pdf", "application/pdf", new Uint8Array([1])),
      file("af_z", "a.zip", "application/zip", new Uint8Array([1])),
    ]);
    const textOnly: ModelDescriptor = {
      provider: "groq",
      id: "llama",
      inputs: ["text"],
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
    };
    const read = (artifactId: string, model?: ModelDescriptor) =>
      runArtifactTool(
        call("read_artifact", { artifactId }),
        tool(core.channel, model ? { model } : {}),
      );
    expect(await read("af_p", textOnly)).toEqual({
      kind: "failed",
      code: "artifact.unsupported",
      message: "chart.png is image/png: this model does not read images.",
    });
    expect(await read("af_d", { ...textOnly, inputs: ["text", "image", "pdf"] })).toMatchObject({
      kind: "completed",
      files: [{ mediaType: "application/pdf" }],
    });
    // Without a descriptor the model is taken to read text and images.
    expect(await read("af_d")).toMatchObject({
      kind: "failed",
      code: "artifact.unsupported",
      message: "spec.pdf is application/pdf: this model does not read PDFs.",
    });
    expect(await read("af_z")).toMatchObject({
      code: "artifact.unsupported",
      message: "a.zip is application/zip: no model reads application/zip files.",
    });
  });

  it("fails what it cannot read: bad input, a folder, past the end, not the session's", async () => {
    const folder = {
      ...file("af_f", "outputs", "application/vnd.nylorun.folder+json", ""),
      meta: { ...file("af_f", "outputs", "x/y", "").meta, kind: "folder" as const },
    };
    const core = fakeCore([file("af_t", "log.txt", "text/plain", "abc"), folder]);
    const run = (input: unknown, pageBytes?: number) =>
      runArtifactTool(
        call("read_artifact", input),
        tool(core.channel, pageBytes ? { pageBytes } : {}),
      );
    for (const input of [
      {},
      { artifactId: "af_t", version: 0 },
      { artifactId: "af_t", offset: -1 },
      { artifactId: "af_t", length: 11 },
    ])
      expect(await run(input, 10), JSON.stringify(input)).toMatchObject({
        kind: "failed",
        code: "artifact.invalid_input",
        message:
          "Give artifactId, a version of 1 or more if any, an offset of 0 or more, and a length of 1 to 10.",
      });
    expect(await run({ artifactId: "af_f" })).toMatchObject({
      code: "artifact.not_text",
      message: "outputs is a folder; read_artifact reads a file.",
    });
    expect(await run({ artifactId: "af_t", offset: 3 })).toMatchObject({
      code: "artifact.invalid_input",
      message: "Offset 3 is past the end of log.txt, which is 3 bytes.",
    });
    expect(await run({ artifactId: "af_t", offset: 4 })).toMatchObject({
      code: "artifact.invalid_input",
    });
    expect(await run({ artifactId: "af_other" })).toEqual({
      kind: "failed",
      code: "artifact.not_found",
      message: "Artifact af_other is not an artifact of this session.",
    });
  });

  it("copies an artifact into the sandbox with path, chunk by chunk, and shows nothing of it", async () => {
    const bytes = new Uint8Array(10).map((_, at) => at);
    const core = fakeCore([file("af_b", "data.bin", "application/octet-stream", bytes)]);
    const files = sandboxFiles();
    const outcome = await runArtifactTool(
      call("read_artifact", { artifactId: "af_b", path: "in/data.bin" }),
      tool(core.channel, { files: files.port, chunkBytes: 4 }),
    );
    expect(outcome).toEqual({
      kind: "completed",
      output: {
        artifactId: "af_b",
        version: 1,
        name: "data.bin",
        contentType: "application/octet-stream",
        size: 10,
        path: "/workspace/in/data.bin",
      },
    });
    expect(files.written["/workspace/in/data.bin"]).toEqual(bytes);
    expect(core.requests.map((request) => request.params.offset)).toEqual([0, 4, 8]);
    // Without a sandbox, a path has nowhere to go.
    expect(
      await runArtifactTool(
        call("read_artifact", { artifactId: "af_b", path: "x" }),
        tool(core.channel),
      ),
    ).toMatchObject({
      code: "artifact.no_sandbox",
    });
  });
});

describe("save_artifact", () => {
  it("saves text with the call's effect id as its key, typed text/plain when the name says nothing", async () => {
    const core = fakeCore([]);
    const outcome = await runArtifactTool(
      call("save_artifact", { content: "hello", name: "note" }),
      tool(core.channel, { sandbox: true }),
    );
    expect(outcome).toEqual({
      kind: "completed",
      output: {
        artifactId: "af_1",
        version: 1,
        name: "note",
        contentType: "text/plain; charset=utf-8",
        size: 5,
        sha256: sha,
      },
    });
    // One begin with the whole body: the effect is the key and the provenance.
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]!.params).toMatchObject({
      op: "begin",
      key: "t1:0:tool:c1",
      effectId: "t1:0:tool:c1",
      name: "note",
      contentType: "text/plain; charset=utf-8",
    });
    // The same call again (a repeat after a lost answer) answers the version it wrote.
    const again = await runArtifactTool(
      call("save_artifact", { content: "hello", name: "note" }),
      tool(core.channel, { sandbox: true }),
    );
    expect(again).toEqual(outcome);
    expect(core.saved).toHaveLength(1);
    // A name with an extension types the file by it.
    await runArtifactTool(
      call("save_artifact", { content: "# t", name: "t.md" }, "t1:0:tool:c2"),
      tool(core.channel, { sandbox: true }),
    );
    expect(core.saved[1]!.begin).toMatchObject({ contentType: "text/markdown" });
  });

  it("saves a sandbox file by path: read within the upload's room, sent in chunks, committed", async () => {
    const core = fakeCore([]);
    const files = sandboxFiles({ "/workspace/out/report.pdf": new Uint8Array(9).fill(1) });
    const outcome = await runArtifactTool(
      call("save_artifact", { path: "out/report.pdf" }),
      tool(core.channel, { files: files.port, chunkBytes: 4 }),
    );
    expect(outcome).toMatchObject({
      kind: "completed",
      output: { name: "report.pdf", contentType: "application/pdf", size: 9 },
    });
    expect(files.reads).toEqual([{ path: "out/report.pdf", maxBytes: 1000 }]);
    expect(core.requests.map((request) => request.params.op)).toEqual([
      "begin",
      "chunk",
      "chunk",
      "chunk",
      "commit",
    ]);
    expect(core.saved[0]!.bytes).toEqual(new Uint8Array(9).fill(1));
  });

  it("aborts the upload for a file that is missing or too large, and refuses what it cannot save", async () => {
    const core = fakeCore([]);
    const files = sandboxFiles({ "/workspace/big": new Uint8Array(2000) });
    const save = (input: unknown, options: Parameters<typeof tool>[1] = { files: files.port }) =>
      runArtifactTool(call("save_artifact", input), tool(core.channel, options));
    expect(await save({ path: "nope.txt" })).toEqual({
      kind: "failed",
      code: "artifact.not_found",
      message: "/workspace/nope.txt does not exist in the sandbox.",
    });
    expect(await save({ path: "big" })).toMatchObject({
      kind: "failed",
      code: "artifact.too_large",
    });
    expect(core.requests.filter((request) => request.params.op === "abort")).toHaveLength(2);
    expect(core.uploads.size).toBe(0);
    expect(core.saved).toEqual([]);
    expect(await save({ path: "a", content: "b" })).toMatchObject({
      code: "artifact.invalid_input",
      message: "Give path or content, not both.",
    });
    expect(await save({})).toMatchObject({ code: "artifact.invalid_input" });
    expect(await save({ content: "x", contentType: "not a type" })).toMatchObject({
      code: "artifact.invalid_input",
      message: "not a type is not a media type.",
    });
    expect(await save({ path: "a" }, {})).toMatchObject({ code: "artifact.no_sandbox" });
    // Past a Runtime limit: too large, with core's message.
    const small = fakeCore([], { maxBytes: 4 });
    expect(
      await runArtifactTool(
        call("save_artifact", { content: "too long" }),
        tool(small.channel, { sandbox: true }),
      ),
    ).toEqual({
      kind: "failed",
      code: "artifact.too_large",
      message: "A file may hold at most 4 bytes (limitBytes 4)",
    });
  });
});

describe("the API host", () => {
  it("runs our artifact tools itself, never through the executors' tool call", async () => {
    const core = fakeCore([file("af_t", "log.txt", "text/plain", "abc")]);
    // core answers the intent with execute, then records the outcome: the seam is the same channel.
    const outcomes: unknown[] = [];
    const channel = {
      request: async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        if (method === "effect.intent") return { status: "execute" };
        if (method === "effect.outcome") {
          outcomes.push(params.value);
          return { status: "completed", outcome: { value: params.value } };
        }
        return core.channel.request(method as "artifact.read", params as never, signal);
      },
    } as unknown as HarnessChannel;
    let toolCalls = 0;
    const executors: HarnessExecutors = {
      model: async () => ({}),
      tool: async () => {
        toolCalls += 1;
        return {};
      },
      recovers: { model: false, tool: () => false },
    };
    const host = apiHost(
      channel,
      executors,
      { ...run(), start: { ...run().start, outcomes: [] } },
      engineConfig({ artifactPageBytes: 4 }),
    );
    const resolved = await host.resolveEffect(call("read_artifact", { artifactId: "af_t" }));
    expect(resolved).toMatchObject({
      status: "completed",
      outcome: { value: { kind: "completed", output: { content: "ab", nextOffset: 2 } } },
    });
    expect(toolCalls).toBe(0);
    // A sandbox call goes to the executors, by its target, whatever it is named.
    await host.resolveEffect(call("bash", { command: "ls" }, "t1:0:tool:c9", { kind: "sandbox" }));
    expect(toolCalls).toBe(1);
    await host.resolveEffect(
      call("read_artifact", { artifactId: "af_t" }, "t1:0:tool:c8", {
        kind: "mcp",
        server: "docs",
        tool: "read_artifact",
      }),
    );
    expect(toolCalls).toBe(2);
  });
});
