import { describe, expect, it } from "vitest";
import {
  HarnessApiError,
  fromBase64,
  memoryChannels,
  openArtifactWrite,
  readArtifact,
  toBase64,
  writeArtifactBytes,
  type ArtifactMeta,
  type ParamsOf,
} from "../src/harness-api/index.js";

const meta = (fields: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  artifactId: "af_1",
  kind: "file",
  name: "notes.txt",
  version: 1,
  contentType: "text/plain",
  size: 0,
  sha256: "0".repeat(64),
  tenantWide: false,
  ...fields,
});

/** A core that serves the artifact seam from memory, recording each request. */
function seam(stored: Uint8Array, version = 1) {
  const { harness, core } = memoryChannels({ json: true });
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const uploads = new Map<string, Uint8Array[]>();
  const written = new Map<string, ArtifactMeta>();
  core.handle(async (method, params) => {
    const p = params as Record<string, unknown>;
    requests.push({ method, params: p });
    if (method === "artifact.read") {
      const { offset = 0, length = 4 } = p as ParamsOf<"artifact.read">;
      const bytes = stored.subarray(offset, offset + length);
      return {
        artifact: meta({ size: stored.byteLength, version: (p.version as number | undefined) ?? version }),
        offset,
        base64: toBase64(bytes),
        eof: offset + bytes.byteLength >= stored.byteLength,
      };
    }
    const write = p as ParamsOf<"artifact.write">;
    if (write.op === "begin") {
      const known = written.get(write.key);
      if (known) return { status: "written", artifact: known, created: false };
      if (write.base64 !== undefined) {
        const artifact = meta({ name: write.name!, size: fromBase64(write.base64).byteLength });
        written.set(write.key, artifact);
        return { status: "written", artifact, created: true };
      }
      uploads.set(write.key, []);
      return { status: "open", uploadId: write.key, maxBytes: 100, received: 0 };
    }
    if (write.op === "chunk") {
      const chunks = uploads.get(write.uploadId)!;
      const received = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (write.offset !== received) throw new HarnessApiError("invalid", "out of order");
      chunks.push(fromBase64(write.base64));
      return { status: "open", uploadId: write.uploadId, maxBytes: 100, received: received + chunks.at(-1)!.byteLength };
    }
    if (write.op === "commit") {
      const size = uploads.get(write.uploadId)!.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const artifact = meta({ size });
      written.set(write.uploadId, artifact);
      return { status: "written", artifact, created: true };
    }
    uploads.delete(write.uploadId);
    return { status: "aborted" };
  });
  return { harness, requests, uploads };
}

describe("the artifact seam's client", () => {
  it("reads an artifact chunk by chunk, pinning the version the first answer named", async () => {
    const bytes = new TextEncoder().encode("hello, world");
    const { harness, requests } = seam(bytes, 3);
    const opened = await readArtifact(harness, { runId: "r", artifactId: "af_1", chunkBytes: 5 });
    expect(opened.artifact).toMatchObject({ version: 3, size: 12 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened.chunks()) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([5, 5, 2]);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("hello, world");
    expect(requests.map((request) => request.params)).toEqual([
      { runId: "r", artifactId: "af_1", offset: 0, length: 5 },
      { runId: "r", artifactId: "af_1", version: 3, offset: 5, length: 5 },
      { runId: "r", artifactId: "af_1", version: 3, offset: 10, length: 5 },
    ]);
  });

  it("reads an empty artifact in one request", async () => {
    const { harness, requests } = seam(new Uint8Array());
    const opened = await readArtifact(harness, { runId: "r", artifactId: "af_1", chunkBytes: 5 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened.chunks()) chunks.push(chunk);
    expect(chunks).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("writes bytes that fit one chunk in the begin, and larger ones as an upload", async () => {
    const { harness, requests } = seam(new Uint8Array());
    const small = await writeArtifactBytes(
      harness,
      { runId: "r", key: "k1", name: "a.txt", chunkBytes: 8 },
      new TextEncoder().encode("abc")
    );
    expect(small).toMatchObject({ created: true, artifact: { size: 3 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params).toMatchObject({ op: "begin", key: "k1", size: 3, base64: toBase64(new Uint8Array([97, 98, 99])) });

    requests.length = 0;
    const big = await writeArtifactBytes(
      harness,
      { runId: "r", key: "k2", name: "b.bin", effectId: "t1:0:tool:c1", chunkBytes: 4 },
      new Uint8Array(10).fill(7)
    );
    expect(big).toMatchObject({ created: true, artifact: { size: 10 } });
    expect(requests.map((request) => [request.params.op, request.params.offset])).toEqual([
      ["begin", undefined],
      ["chunk", 0],
      ["chunk", 4],
      ["chunk", 8],
      ["commit", undefined],
    ]);
    expect(requests[0]!.params).toMatchObject({ effectId: "t1:0:tool:c1", size: 10 });
    expect(requests[0]!.params).not.toHaveProperty("base64");
  });

  it("answers a key written before without sending its bytes again", async () => {
    const { harness, requests } = seam(new Uint8Array());
    const options = { runId: "r", key: "k", name: "c.bin", chunkBytes: 2 };
    await writeArtifactBytes(harness, options, new Uint8Array(5));
    requests.length = 0;
    const again = await openArtifactWrite(harness, options);
    expect(again).toMatchObject({ kind: "written", created: false });
    expect(requests).toHaveLength(1);
  });

  it("aborts the upload when a chunk is refused", async () => {
    const { harness, requests, uploads } = seam(new Uint8Array());
    const upload = await openArtifactWrite(harness, { runId: "r", key: "k", name: "d.bin", chunkBytes: 4 });
    if (upload.kind !== "open") throw new Error("expected an open upload");
    await upload.write(new Uint8Array(3));
    // Core refuses a chunk past what it received (another writer, a lost answer).
    await expect(
      harness.request("artifact.write", { runId: "r", op: "chunk", uploadId: upload.uploadId, offset: 0, base64: "AA==" })
    ).rejects.toMatchObject({ code: "invalid" });
    await upload.abort();
    expect(uploads.has("k")).toBe(false);
    expect(requests.at(-1)!.params).toEqual({ runId: "r", op: "abort", uploadId: "k" });
  });

  it("round-trips base64", () => {
    const bytes = new Uint8Array(70_000).map((_, at) => at % 251);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
