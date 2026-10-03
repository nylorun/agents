/**
 * The `BlobStore` seam (blueprint D35, F8.1): the only way the Runtime reaches the Object
 * store. Bytes live here; what they mean lives in Postgres, which is the commit point: an
 * object counts only once a committed row references its key, so an orphaned upload is
 * garbage, never data. Keys are chosen by the Runtime (fresh random ids), so the seam needs no
 * conditional writes.
 *
 * Two adapters, held to one conformance suite (`test/blob/conformance.ts`):
 * - `s3` (`./s3.ts`): the plain S3 API, against RustFS in the local stack and S3 or any S3
 *   server elsewhere;
 * - `fs` (`./fs.ts`): files under a directory, for embedding and tests.
 */

/** A body to store: bytes, a web stream, or any async iterable of chunks (a Node stream). */
export type BlobBody =
  | Uint8Array
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface BlobPutOptions {
  /** Stored with the object and returned by `head` and `get`. Default `application/octet-stream`. */
  contentType?: string;
  /**
   * Refuse a body longer than this many bytes with `BlobTooLargeError`; nothing is stored. The
   * body is counted as it streams, so a caller need not know its length up front.
   */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface BlobPutResult {
  key: string;
  /** Bytes stored. */
  size: number;
  /** SHA-256 of the bytes stored, lowercase hex. */
  sha256: string;
}

export interface BlobMeta {
  key: string;
  /** The whole object's size in bytes. */
  size: number;
  contentType: string;
  lastModified: Date;
}

/** Bytes `start` to `end`, both inclusive, as in an HTTP `Range` header. */
export interface BlobRange {
  start: number;
  /** Inclusive; past the end of the object means "to the end". Default: to the end. */
  end?: number;
}

export interface BlobGetOptions {
  /** Only these bytes. A range that starts at or past the end throws `BlobRangeError`. */
  range?: BlobRange;
  signal?: AbortSignal;
}

export interface BlobGetResult extends BlobMeta {
  /** The bytes asked for: the whole object, or the range. Read it or cancel it. */
  body: ReadableStream<Uint8Array>;
  /** Present when a range was asked for: the bytes `body` holds, both inclusive. */
  range?: { start: number; end: number };
}

/** An entry of `list`: the object's key, size and when it was last written. */
export interface BlobListEntry {
  key: string;
  size: number;
  lastModified: Date;
}

export interface BlobStore {
  /** Which adapter this is, for logs and `/ready`. */
  readonly kind: "fs" | "s3";
  /** Store `body` at `key`, replacing what is there. Streams; counts and hashes as it goes. */
  put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobPutResult>;
  /** The object's bytes and metadata, or `undefined` when there is none at `key`. */
  get(key: string, options?: BlobGetOptions): Promise<BlobGetResult | undefined>;
  /** The object's metadata, or `undefined` when there is none at `key`. */
  head(key: string): Promise<BlobMeta | undefined>;
  /** Remove the object; removing one that is not there succeeds. */
  delete(key: string): Promise<void>;
  /** Every object whose key starts with `prefix`, in key order. */
  list(prefix: string): AsyncIterable<BlobListEntry>;
}

/** The Object store failed or refused a request; `status` is the HTTP status when it has one. */
export class BlobStoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BlobStoreError";
  }
}

/** A `put` body grew past `maxBytes`. Nothing was stored. */
export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The body is larger than ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/** A `get` range starts at or past the end of the object (HTTP 416). */
export class BlobRangeError extends Error {
  constructor(
    readonly range: BlobRange,
    readonly size: number,
  ) {
    super(`Range ${range.start}-${range.end ?? ""} is outside an object of ${size} bytes`);
    this.name = "BlobRangeError";
  }
}

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";
export const MAX_KEY_BYTES = 1024;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Keys are `/`-separated segments of `A-Z a-z 0-9 . _ -`, neither `.` nor `..`, at most 1024
 * bytes: safe as S3 keys without encoding surprises and as relative paths for `fs`.
 */
export function assertBlobKey(key: string): void {
  if (typeof key !== "string" || key === "" || key.length > MAX_KEY_BYTES)
    throw new TypeError(`Blob key must be 1 to ${MAX_KEY_BYTES} characters`);
  for (const segment of key.split("/"))
    if (!SEGMENT.test(segment) || segment === "." || segment === "..")
      throw new TypeError(
        `Blob key ${JSON.stringify(key)} must be /-separated segments of A-Z a-z 0-9 . _ -, none . or ..`,
      );
}

/** A `list` prefix: empty, a key, or a key followed by `/` (or the start of a segment). */
export function assertBlobPrefix(prefix: string): void {
  if (prefix === "") return;
  assertBlobKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

export function assertRange(range: BlobRange): void {
  if (!Number.isSafeInteger(range.start) || range.start < 0)
    throw new TypeError("Range start must be a non-negative integer");
  if (range.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < range.start))
    throw new TypeError("Range end must be an integer no smaller than start");
}

export function assertMaxBytes(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0))
    throw new TypeError("maxBytes must be a non-negative integer");
}

/** The chunks of a `BlobBody`, as `Uint8Array`s. */
export async function* chunksOf(body: BlobBody): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array))
      throw new TypeError("A blob body must yield Uint8Array chunks");
    yield chunk;
  }
}
