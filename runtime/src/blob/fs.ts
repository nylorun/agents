import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import {
  BlobRangeError,
  BlobTooLargeError,
  DEFAULT_CONTENT_TYPE,
  assertBlobKey,
  assertBlobPrefix,
  assertMaxBytes,
  assertRange,
  chunksOf,
  type BlobBody,
  type BlobGetOptions,
  type BlobGetResult,
  type BlobListEntry,
  type BlobMeta,
  type BlobPutOptions,
  type BlobPutResult,
  type BlobStore,
} from "./types.js";

export interface FsBlobStoreOptions {
  /** Absolute directory the store owns; created on the first write. */
  root: string;
}

interface StoredMeta {
  contentType: string;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The `fs` adapter: objects as files under `root`, for embedding (`startEphemeralRuntime`, a
 * Host without an Object store) and tests. `objects/<key>` holds the bytes, `meta/<key>.json`
 * the content type; a write goes to `tmp/` first and is renamed into place, so a reader sees
 * the old object or the new one, never part of one. A key cannot also be the directory of
 * another key (`a` and `a/b`); the Runtime's keys never are.
 */
export function createFsBlobStore(options: FsBlobStoreOptions): BlobStore {
  const objects = join(options.root, "objects");
  const metadata = join(options.root, "meta");
  const tmp = join(options.root, "tmp");
  const objectPath = (key: string) => join(objects, ...key.split("/"));
  const metaPath = (key: string) => `${join(metadata, ...key.split("/"))}.json`;

  async function readMeta(key: string): Promise<StoredMeta> {
    try {
      const parsed = JSON.parse(await readFile(metaPath(key), "utf8")) as Partial<StoredMeta>;
      return { contentType: parsed.contentType ?? DEFAULT_CONTENT_TYPE };
    } catch {
      return { contentType: DEFAULT_CONTENT_TYPE };
    }
  }

  async function head(key: string): Promise<BlobMeta | undefined> {
    assertBlobKey(key);
    let stats;
    try {
      stats = await stat(objectPath(key));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!stats.isFile()) return undefined;
    const meta = await readMeta(key);
    return { key, size: stats.size, contentType: meta.contentType, lastModified: stats.mtime };
  }

  return {
    kind: "fs",

    async put(key: string, body: BlobBody, put: BlobPutOptions = {}): Promise<BlobPutResult> {
      assertBlobKey(key);
      assertMaxBytes(put.maxBytes);
      put.signal?.throwIfAborted();
      await mkdir(tmp, { recursive: true });
      const id = randomUUID();
      const dataTmp = join(tmp, id);
      const metaTmp = join(tmp, `${id}.json`);
      const hash = createHash("sha256");
      let size = 0;
      const file = await open(dataTmp, "wx", 0o600);
      try {
        try {
          for await (const chunk of chunksOf(body)) {
            put.signal?.throwIfAborted();
            size += chunk.byteLength;
            if (put.maxBytes !== undefined && size > put.maxBytes)
              throw new BlobTooLargeError(put.maxBytes);
            hash.update(chunk);
            await file.write(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        const stored: StoredMeta = { contentType: put.contentType ?? DEFAULT_CONTENT_TYPE };
        await writeTmp(metaTmp, JSON.stringify(stored));
        await mkdir(dirname(objectPath(key)), { recursive: true });
        await mkdir(dirname(metaPath(key)), { recursive: true });
        await rename(metaTmp, metaPath(key));
        await rename(dataTmp, objectPath(key));
      } catch (error) {
        await rm(dataTmp, { force: true });
        await rm(metaTmp, { force: true });
        throw error;
      }
      return { key, size, sha256: hash.digest("hex") };
    },

    async get(key: string, get: BlobGetOptions = {}): Promise<BlobGetResult | undefined> {
      assertBlobKey(key);
      if (get.range) assertRange(get.range);
      get.signal?.throwIfAborted();
      let file;
      try {
        file = await open(objectPath(key), "r");
      } catch (error) {
        if (isMissing(error) || (error as NodeJS.ErrnoException)?.code === "EISDIR")
          return undefined;
        throw error;
      }
      try {
        const stats = await file.stat();
        if (!stats.isFile()) {
          await file.close();
          return undefined;
        }
        const meta = await readMeta(key);
        const base = {
          key,
          size: stats.size,
          contentType: meta.contentType,
          lastModified: stats.mtime,
        };
        if (!get.range) {
          const stream = file.createReadStream({ autoClose: true });
          return { ...base, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
        }
        if (get.range.start >= stats.size) throw new BlobRangeError(get.range, stats.size);
        const end = Math.min(get.range.end ?? stats.size - 1, stats.size - 1);
        const stream = file.createReadStream({ start: get.range.start, end, autoClose: true });
        return {
          ...base,
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          range: { start: get.range.start, end },
        };
      } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
      }
    },

    head,

    async delete(key: string): Promise<void> {
      assertBlobKey(key);
      for (const path of [objectPath(key), metaPath(key)])
        try {
          await unlink(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (!isMissing(error) && code !== "EISDIR" && code !== "EPERM") throw error;
        }
    },

    async *list(prefix: string): AsyncIterable<BlobListEntry> {
      assertBlobPrefix(prefix);
      // Walk the deepest directory the prefix names, then filter and sort: `a-b` sorts before
      // `a/c`, so directory order is not key order.
      const slash = prefix.lastIndexOf("/");
      const start = slash < 0 ? objects : join(objects, ...prefix.slice(0, slash).split("/"));
      const found: BlobListEntry[] = [];
      const walk = async (directory: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) {
            const key = relative(objects, path).split(sep).join("/");
            if (!key.startsWith(prefix)) continue;
            const stats = await stat(path).catch(() => undefined);
            if (stats) found.push({ key, size: stats.size, lastModified: stats.mtime });
          }
        }
      };
      await walk(start);
      found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      yield* found;
    },
  };
}

async function writeTmp(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
  } finally {
    await file.close();
  }
}
