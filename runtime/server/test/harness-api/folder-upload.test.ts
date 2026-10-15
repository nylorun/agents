/**
 * Folder versions over the artifact seam (`artifact.write` with `kind: "folder"`, protocol 15): a
 * harness sends each file with its hash, core takes every byte (stored or not), refuses a file
 * whose bytes do not match its hash, adds no version when the files are the folder's latest,
 * refuses a version past a total, finds the session's folder by name, and answers a key written
 * before with its version. A fake harness holds a real run over the memory channel, every frame
 * validated.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  memoryChannels,
  toBase64,
  type HarnessChannel,
  type RunGrant,
} from "@nylorun/core/harness-api";
import { contentKey } from "../../src/artifacts/folders.js";
import type { BlobStore } from "../../src/blob/index.js";
import { boot, openSession, server, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(bytes(text)).digest("hex");

async function putLimits(runtime: Started, path: string, limits: Record<string, number>) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ limits }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

const blobsOf = (runtime: Started) => (runtime.handle as unknown as { ctx: { blobs: BlobStore } }).ctx.blobs;

interface Held {
  readonly runtime: Started;
  readonly harness: HarnessChannel;
  readonly run: RunGrant;
}

/** A Runtime with only the fake harness connected, holding session s1's run. */
async function hold(options: { chunkBytes?: number; folderEntries?: number } = {}): Promise<Held> {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const limits = {
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
    ...(options.folderEntries === undefined ? {} : { folderEntries: options.folderEntries }),
  };
  if (Object.keys(limits).length > 0) await putLimits(runtime, "/v1/tenant/limits", limits);
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  const harness = channels.harness;
  await harness.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  await openSession(runtime, "s1");
  const leased = harness.request("lease", {});
  const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", parts: [{ type: "text", text: "go" }] }),
  });
  expect(sent.status).toBe(200);
  const { run } = await leased;
  cleanups.unshift(async () => {
    await harness.request("turn.completed", { runId: run.runId, status: "completed", state: {}, output: "done" }).catch(() => undefined);
  });
  return { runtime, harness, run };
}

const write = (held: Held, params: Record<string, unknown>) =>
  held.harness.request("artifact.write", { runId: held.run.runId, ...params } as never) as Promise<any>;

const begin = (held: Held, key: string, fields: Record<string, unknown> = {}) =>
  write(held, { op: "begin", kind: "folder", key, name: "outputs", sameName: true, ...fields });

const file = (held: Held, uploadId: string, path: string, text: string, fields: Record<string, unknown> = {}) =>
  write(held, { op: "file", uploadId, path, size: bytes(text).byteLength, sha256: sha(text), base64: toBase64(bytes(text)), ...fields });

async function tree(held: Held, artifactId: string, version: number) {
  const response = await fetch(`${held.runtime.url}/v1/artifacts/${artifactId}/versions/${version}/tree`, {
    headers: { authorization: server.authorization },
  });
  return ((await response.json()) as { entries: { path: string; sha256: string }[] }).entries;
}

describe("a folder version over the artifact seam", () => {
  it("writes files whole and in chunks, then commits a version of the session's folder", async () => {
    const held = await hold({ chunkBytes: 4 });
    const begun = await begin(held, "outputs:t1");
    expect(begun).toMatchObject({ status: "open", maxBytes: expect.any(Number), maxFileBytes: expect.any(Number), maxEntries: 10_000 });
    const { uploadId } = begun;
    expect(await file(held, uploadId, "a.txt", "abc")).toMatchObject({ status: "open", received: 3 });
    // A file larger than a chunk: its chunks name it by hash, from offsets within it.
    const big = "0123456789";
    expect(await write(held, { op: "file", uploadId, path: "dir/big.txt", size: 10, sha256: sha(big) })).toMatchObject({ received: 0 });
    for (const offset of [0, 4, 8])
      await write(held, { op: "chunk", uploadId, sha256: sha(big), offset, base64: toBase64(bytes(big.slice(offset, offset + 4))) });
    const done = await write(held, { op: "commit", uploadId });
    expect(done).toMatchObject({ status: "written", created: true, artifact: { kind: "folder", name: "outputs", version: 1, size: 13 } });
    expect((await tree(held, done.artifact.artifactId, 1)).map((entry) => entry.path)).toEqual(["a.txt", "dir/big.txt"]);
    const content = await fetch(`${held.runtime.url}/v1/artifacts/${done.artifact.artifactId}/versions/1/files/${encodeURIComponent("dir/big.txt")}`, {
      headers: { authorization: server.authorization },
    });
    expect(await content.text()).toBe(big);

    // The same key again: the version it wrote, nothing stored.
    expect(await begin(held, "outputs:t1")).toMatchObject({ status: "written", created: false, artifact: { version: 1 } });
    // The same files under another key: no new version (unchanged); then new files add one, to the
    // same folder (`sameName`).
    const again = await begin(held, "outputs:t2");
    await file(held, again.uploadId, "a.txt", "abc");
    await write(held, { op: "file", uploadId: again.uploadId, path: "dir/big.txt", size: 10, sha256: sha(big) });
    for (const offset of [0, 4, 8])
      await write(held, { op: "chunk", uploadId: again.uploadId, sha256: sha(big), offset, base64: toBase64(bytes(big.slice(offset, offset + 4))) });
    expect(await write(held, { op: "commit", uploadId: again.uploadId })).toMatchObject({
      status: "written",
      created: false,
      unchanged: true,
      artifact: { artifactId: done.artifact.artifactId, version: 1 },
    });
    const third = await begin(held, "outputs:t3");
    await file(held, third.uploadId, "a.txt", "new");
    expect(await write(held, { op: "commit", uploadId: third.uploadId })).toMatchObject({
      status: "written",
      created: true,
      artifact: { artifactId: done.artifact.artifactId, version: 2 },
    });
  });

  it("takes every byte of content the store holds, and refuses bytes that do not match their hash", async () => {
    const held = await hold();
    const blobs = blobsOf(held.runtime);
    const first = await begin(held, "k1");
    await file(held, first.uploadId, "a.txt", "known");
    await write(held, { op: "commit", uploadId: first.uploadId });
    expect(await blobs.head(contentKey(sha("known")))).toBeDefined();

    // Content the store holds still needs its bytes: a hash alone proves nothing.
    const second = await begin(held, "k2", { sameName: undefined, name: "other" });
    await expect(
      write(held, { op: "file", uploadId: second.uploadId, path: "a.txt", size: 5, sha256: sha("known"), base64: toBase64(bytes("lies!")) }),
    ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("do not match") });
    // The upload ended with it.
    await expect(write(held, { op: "commit", uploadId: second.uploadId })).rejects.toMatchObject({ code: "invalid" });

    // New content with a false hash is never stored under the hash it claims.
    const third = await begin(held, "k3", { name: "third" });
    await expect(
      write(held, { op: "file", uploadId: third.uploadId, path: "b.txt", size: 5, sha256: sha("other"), base64: toBase64(bytes("wrong")) }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await blobs.head(contentKey(sha("other")))).toBeUndefined();
    expect(await blobs.head(contentKey(sha("wrong")))).toBeUndefined();
  });

  it("refuses bad paths, repeated paths, files past their limits, and too many files", async () => {
    const held = await hold({ folderEntries: 2 });
    await putLimits(held.runtime, "/v1/tenant/artifacts", { fileBytes: 4 });
    const fresh = async () => (await begin(held, `k${Math.random()}`)).uploadId as string;
    for (const path of ["/abs", "a/../b", "a//b", "./a"])
      await expect(file(held, await fresh(), path, "x")).rejects.toMatchObject({ code: "invalid" });
    const repeated = await fresh();
    await file(held, repeated, "a", "x");
    await expect(file(held, repeated, "a", "y")).rejects.toMatchObject({ code: "invalid" });
    await expect(file(held, await fresh(), "big", "12345")).rejects.toMatchObject({ code: "limit_exceeded" });
    const many = await fresh();
    await file(held, many, "a", "1");
    await file(held, many, "b", "2");
    await expect(file(held, many, "c", "3")).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("folderEntries"),
    });
  });

  it("answers refused past a total, and keeps nothing it stored", async () => {
    const held = await hold();
    await putLimits(held.runtime, "/v1/tenant/artifacts", { totalBytes: 8 });
    const begun = await begin(held, "k1");
    expect(begun.maxBytes).toBe(8);
    await file(held, begun.uploadId, "a.txt", "1234");
    await file(held, begun.uploadId, "b.txt", "5678");
    // Within the folder's own bound, but the Tenant holds other bytes now.
    const other = await fetch(`${held.runtime.url}/v1/artifacts?name=x.txt&sessionId=s1`, {
      method: "POST",
      headers: { authorization: server.authorization, "content-type": "text/plain" },
      body: "abc",
    });
    expect(other.status).toBe(201);
    expect(await write(held, { op: "commit", uploadId: begun.uploadId })).toMatchObject({
      status: "refused",
      reason: "tenant_total",
      limit: 8,
    });
    expect(await blobsOf(held.runtime).head(contentKey(sha("1234")))).toBeUndefined();
  });
});
