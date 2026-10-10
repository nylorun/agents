import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobTooLargeError, createFsBlobStore } from "../../src/blob/index.js";
import { blobStoreConformance } from "./conformance.js";

blobStoreConformance("fs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-blob-"));
  return {
    store: createFsBlobStore({ root }),
    // The fs adapter has no parts; the suite still crosses 5 MiB.
    partSize: 5 * 1024 * 1024,
    close: () => rm(root, { recursive: true, force: true }),
  };
});

describe("fs BlobStore", () => {
  it("leaves no temporary file behind when a put fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-blob-"));
    try {
      const store = createFsBlobStore({ root });
      await expect(store.put("a/b", new Uint8Array(10), { maxBytes: 5 })).rejects.toBeInstanceOf(
        BlobTooLargeError,
      );
      expect(await readdir(join(root, "tmp"))).toEqual([]);
      await store.put("a/b", new Uint8Array(3));
      expect(await readdir(join(root, "tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates nothing until the first write", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "nylorun-blob-")), "store");
    const store = createFsBlobStore({ root });
    expect(await store.head("x")).toBeUndefined();
    expect(await store.get("x")).toBeUndefined();
    await store.delete("x");
    const listed = [];
    for await (const entry of store.list("")) listed.push(entry);
    expect(listed).toEqual([]);
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
