/**
 * The `BlobStore` conformance suite: every adapter must pass it. `fs-store.test.ts` runs it
 * against the `fs` adapter always; `s3-store.integration.test.ts` against an S3 server (RustFS
 * in the test stack and CI) when `NYLORUN_TEST_S3_ENDPOINT` is set.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlobRangeError,
  BlobTooLargeError,
  type BlobStore,
} from "../../src/blob/index.js";

export interface ConformanceTarget {
  store: BlobStore;
  /** Multipart threshold of the store, so the suite can cross it. */
  partSize: number;
  close?(): Promise<void>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());
const text = (value: string) => new TextEncoder().encode(value);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** `total` bytes in chunks of `chunk`, as an async generator (a Node-style stream). */
async function* generated(data: Uint8Array, chunk: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += chunk)
    yield data.subarray(offset, Math.min(offset + chunk, data.byteLength));
}

export function blobStoreConformance(name: string, open: () => Promise<ConformanceTarget>): void {
  describe(`BlobStore conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let store: BlobStore;
    // Every run writes under its own prefix, so runs can share a bucket.
    const root = `conformance/${randomBytes(6).toString("hex")}`;
    const key = (suffix: string) => `${root}/${suffix}`;

    beforeAll(async () => {
      target = await open();
      store = target.store;
    });

    afterAll(async () => {
      if (!store) return;
      for await (const entry of store.list(`${root}/`)) await store.delete(entry.key);
      await target.close?.();
    });

    it("stores bytes and returns their size and SHA-256", async () => {
      const data = text("hello, object store");
      const put = await store.put(key("hello.txt"), data, { contentType: "text/plain" });
      expect(put).toEqual({ key: key("hello.txt"), size: data.byteLength, sha256: sha256(data) });

      const head = await store.head(key("hello.txt"));
      expect(head).toMatchObject({ key: key("hello.txt"), size: data.byteLength, contentType: "text/plain" });
      expect(head!.lastModified).toBeInstanceOf(Date);
      expect(Math.abs(head!.lastModified.getTime() - Date.now())).toBeLessThan(5 * 60_000);

      const got = await store.get(key("hello.txt"));
      expect(got).toMatchObject({ size: data.byteLength, contentType: "text/plain" });
      expect(got!.range).toBeUndefined();
      expect(await bytesOf(got!.body)).toEqual(data);
    });

    it("streams a body from a web stream, a Node stream or a generator", async () => {
      const data = randomBytes(300_000);
      const web = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < data.byteLength; offset += 65_536)
            controller.enqueue(new Uint8Array(data.subarray(offset, offset + 65_536)));
          controller.close();
        },
      });
      const sources = {
        web,
        node: Readable.from([data.subarray(0, 1000), data.subarray(1000)]),
        generator: generated(data, 7_777),
      };
      for (const [kind, body] of Object.entries(sources)) {
        const put = await store.put(key(`stream-${kind}`), body);
        expect(put.size).toBe(data.byteLength);
        expect(put.sha256).toBe(sha256(data));
        const got = await store.get(key(`stream-${kind}`));
        expect(sha256(await bytesOf(got!.body))).toBe(sha256(data));
      }
    });

    it("defaults the content type and stores an empty object", async () => {
      const put = await store.put(key("empty"), new Uint8Array());
      expect(put).toEqual({ key: key("empty"), size: 0, sha256: sha256(new Uint8Array()) });
      const head = await store.head(key("empty"));
      expect(head).toMatchObject({ size: 0, contentType: "application/octet-stream" });
      const got = await store.get(key("empty"));
      expect((await bytesOf(got!.body)).byteLength).toBe(0);
    });

    it("replaces the object at a key", async () => {
      await store.put(key("replaced"), text("first version"), { contentType: "text/plain" });
      await store.put(key("replaced"), text("second"), { contentType: "application/json" });
      const got = await store.get(key("replaced"));
      expect(got).toMatchObject({ size: 6, contentType: "application/json" });
      expect(new TextDecoder().decode(await bytesOf(got!.body))).toBe("second");
    });

    it("answers undefined for a key that holds nothing", async () => {
      expect(await store.head(key("missing"))).toBeUndefined();
      expect(await store.get(key("missing"))).toBeUndefined();
      expect(await store.get(key("missing"), { range: { start: 0, end: 1 } })).toBeUndefined();
      // A prefix of another key is not an object.
      await store.put(key("dir/child"), text("x"));
      expect(await store.head(key("dir"))).toBeUndefined();
      expect(await store.get(key("dir"))).toBeUndefined();
    });

    it("reads a byte range", async () => {
      const data = text("0123456789abcdefghij");
      await store.put(key("range"), data, { contentType: "text/plain" });
      const read = async (start: number, end?: number) => {
        const got = await store.get(key("range"), { range: end === undefined ? { start } : { start, end } });
        return { got: got!, text: new TextDecoder().decode(await bytesOf(got!.body)) };
      };
      const middle = await read(2, 5);
      expect(middle.text).toBe("2345");
      expect(middle.got).toMatchObject({ size: 20, contentType: "text/plain", range: { start: 2, end: 5 } });
      expect((await read(15)).text).toBe("fghij");
      expect((await read(15)).got.range).toEqual({ start: 15, end: 19 });
      const clamped = await read(18, 1000);
      expect(clamped.text).toBe("ij");
      expect(clamped.got.range).toEqual({ start: 18, end: 19 });
      expect((await read(0, 0)).text).toBe("0");
      expect((await read(19, 19)).text).toBe("j");
    });

    it("refuses a range that starts at or past the end", async () => {
      await store.put(key("short"), text("abc"));
      await expect(store.get(key("short"), { range: { start: 3 } })).rejects.toBeInstanceOf(BlobRangeError);
      await expect(store.get(key("short"), { range: { start: 10, end: 20 } })).rejects.toMatchObject({
        name: "BlobRangeError",
        size: 3,
      });
      await expect(store.get(key("short"), { range: { start: 2, end: 1 } })).rejects.toBeInstanceOf(TypeError);
    });

    it("enforces maxBytes as the body streams, storing nothing and keeping the old object", async () => {
      const capped = await store.put(key("capped"), text("12345"), { maxBytes: 5 });
      expect(capped.size).toBe(5);
      await expect(
        store.put(key("capped"), generated(text("123456"), 2), { maxBytes: 5 }),
      ).rejects.toBeInstanceOf(BlobTooLargeError);
      const kept = await store.get(key("capped"));
      expect(new TextDecoder().decode(await bytesOf(kept!.body))).toBe("12345");

      await expect(store.put(key("never"), text("too long"), { maxBytes: 3 })).rejects.toMatchObject({
        name: "BlobTooLargeError",
        maxBytes: 3,
      });
      expect(await store.head(key("never"))).toBeUndefined();
    });

    it("uploads a body larger than a part, and reads a range across parts", async () => {
      const size = target.partSize * 2 + 12_345;
      const data = randomBytes(size);
      const put = await store.put(key("large.bin"), generated(data, 1024 * 1024 + 3), {
        contentType: "application/x-test",
      });
      expect(put).toEqual({ key: key("large.bin"), size, sha256: sha256(data) });
      const head = await store.head(key("large.bin"));
      expect(head).toMatchObject({ size, contentType: "application/x-test" });
      const whole = await store.get(key("large.bin"));
      expect(sha256(await bytesOf(whole!.body))).toBe(sha256(data));
      const start = target.partSize - 10;
      const got = await store.get(key("large.bin"), { range: { start, end: start + 19 } });
      expect(await bytesOf(got!.body)).toEqual(new Uint8Array(data.subarray(start, start + 20)));
    }, 120_000);

    it("aborts a multipart upload that passes maxBytes", async () => {
      const data = randomBytes(target.partSize + 1024 * 1024);
      await expect(
        store.put(key("large-capped"), generated(data, 1024 * 1024), { maxBytes: target.partSize + 10 }),
      ).rejects.toBeInstanceOf(BlobTooLargeError);
      expect(await store.head(key("large-capped"))).toBeUndefined();
    }, 120_000);

    it("deletes, and deleting what is not there succeeds", async () => {
      await store.put(key("doomed"), text("bye"));
      await store.delete(key("doomed"));
      expect(await store.head(key("doomed"))).toBeUndefined();
      await store.delete(key("doomed"));
      await store.delete(key("never-was"));
    });

    it("lists by prefix in key order", async () => {
      const keys = ["list/b", "list/a-c", "list/a/z", "list/a/b", "list/ab", "lists/x"].map(key);
      for (const [index, item] of keys.entries()) await store.put(item, new Uint8Array(index + 1));
      const all = await collect(store.list(key("list/")));
      expect(all.map((entry) => entry.key)).toEqual(
        ["list/a-c", "list/a/b", "list/a/z", "list/ab", "list/b"].map(key),
      );
      expect(all.find((entry) => entry.key === key("list/a/z"))).toMatchObject({ size: 3 });
      expect(all[0]!.lastModified).toBeInstanceOf(Date);
      expect((await collect(store.list(key("list/a")))).map((entry) => entry.key)).toEqual(
        ["list/a-c", "list/a/b", "list/a/z", "list/ab"].map(key),
      );
      expect((await collect(store.list(key("list/a/")))).map((entry) => entry.key)).toEqual(
        ["list/a/b", "list/a/z"].map(key),
      );
      expect(await collect(store.list(key("nothing-here/")))).toEqual([]);
    });

    it("refuses keys outside the key alphabet", async () => {
      for (const bad of ["", "/abs", "a//b", "a/../b", "./a", "a b", "a?b", "a\\b", "ü", "a/"])
        await expect(store.put(bad, text("x"))).rejects.toBeInstanceOf(TypeError);
      await expect(store.head("../escape")).rejects.toBeInstanceOf(TypeError);
      await expect(collect(store.list("../"))).rejects.toBeInstanceOf(TypeError);
    });
  });
}
