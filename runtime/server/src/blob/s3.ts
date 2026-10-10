import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import {
  BlobRangeError,
  BlobStoreError,
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
  type BlobRange,
  type BlobStore,
} from "./types.js";

export interface S3BlobStoreOptions {
  /** The S3 endpoint, e.g. `http://rustfs:9000` or `https://s3.eu-west-1.amazonaws.com`. */
  endpoint: string;
  bucket: string;
  /** The signing region. Default `us-east-1`, which RustFS accepts. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style URLs (`<endpoint>/<bucket>/<key>`), which RustFS and most S3 servers expect.
   * `false` uses virtual-hosted URLs (`<bucket>.<endpoint host>/<key>`). Default `true`.
   */
  forcePathStyle?: boolean;
  /**
   * A body longer than this is uploaded in parts of about this size (multipart upload); a
   * shorter one in one request. At least 5 MiB, the S3 minimum. Default 8 MiB.
   */
  partSize?: number;
  /** Attempts for a request that fails with a network error, 429 or 5xx. Default 3. */
  attempts?: number;
  /** Replaces the global `fetch` (tests). */
  fetch?: typeof fetch;
}

/** The `s3` adapter, plus the one bucket operation the Runtime needs at boot. */
export interface S3BlobStore extends BlobStore {
  readonly kind: "s3";
  /** Create the bucket unless it exists. The local stack's runtime calls it at boot. */
  ensureBucket(): Promise<void>;
}

const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The text of the first `<name>` element in `xml`, decoded. */
function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);
}

/**
 * The `s3` adapter over the plain S3 API: PutObject, multipart upload, GetObject with Range,
 * HeadObject, DeleteObject and ListObjectsV2, signed with SigV4 by aws4fetch (MIT, no
 * dependencies, built on `fetch` and web streams). It uses no server's admin, KMS or lifecycle
 * API (D35), so RustFS, S3, R2 or any S3 server sits behind it.
 *
 * Uploads stream: the body is counted and hashed as it arrives and sent in parts of
 * `partSize`, so memory stays at about one part whatever the size, and a body that passes
 * `maxBytes` aborts its multipart upload. Each request carries the SHA-256 of its payload,
 * which the server checks. Downloads hand back the response's stream.
 */
export function createS3BlobStore(options: S3BlobStoreOptions): S3BlobStore {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    throw new TypeError("The S3 endpoint must be an http or https URL");
  const base = endpoint.toString().replace(/\/+$/, "");
  const pathStyle = options.forcePathStyle !== false;
  const bucketUrl = pathStyle
    ? `${base}/${options.bucket}`
    : `${endpoint.protocol}//${options.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}`;
  const partSize = Math.max(options.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE);
  const attempts = Math.max(1, options.attempts ?? 3);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: options.region ?? "us-east-1",
    retries: 0,
  });

  const objectUrl = (key: string, query?: Record<string, string>): string => {
    const url = new URL(`${bucketUrl}/${key}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  };

  /** One signed request; retried on a network error, 429 or 5xx unless `once`. */
  async function send(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
    once = false,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= (once ? 1 : attempts); attempt += 1) {
      try {
        const response = await fetchImpl(await client.sign(url, init));
        if ((response.status >= 500 || response.status === 429) && attempt < attempts && !once) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
          continue;
        }
        return response;
      } catch (error) {
        if (init.signal?.aborted) throw error;
        lastError = error;
        if (attempt < (once ? 1 : attempts))
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    throw new BlobStoreError(
      `The Object store is unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async function failure(response: Response, what: string): Promise<BlobStoreError> {
    const text = await response.text().catch(() => "");
    const code = tag(text, "Code");
    const message = tag(text, "Message");
    return new BlobStoreError(
      `${what} failed: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
      response.status,
      code,
    );
  }

  /** PUT with the payload's SHA-256, which the server verifies. */
  const putBytes = (url: string, bytes: Uint8Array, headers: Record<string, string>, signal?: AbortSignal) =>
    send(url, {
      method: "PUT",
      // fetch sends any ArrayBufferView; the DOM types want one over an ArrayBuffer.
      body: bytes as Uint8Array<ArrayBuffer>,
      headers: { ...headers, "x-amz-content-sha256": sha256Hex(bytes) },
      ...(signal ? { signal } : {}),
    });

  async function head(key: string): Promise<BlobMeta | undefined> {
    assertBlobKey(key);
    const response = await send(objectUrl(key), { method: "HEAD" });
    if (response.status === 404) return undefined;
    if (!response.ok) throw await failure(response, `HEAD ${key}`);
    return metaOf(key, response.headers, Number(response.headers.get("content-length") ?? 0));
  }

  function metaOf(key: string, headers: Headers, size: number): BlobMeta {
    const modified = headers.get("last-modified");
    return {
      key,
      size,
      contentType: headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
      lastModified: modified ? new Date(modified) : new Date(0),
    };
  }

  async function putMultipart(
    key: string,
    first: Uint8Array,
    rest: AsyncIterator<Uint8Array>,
    state: { size: number; hash: ReturnType<typeof createHash> },
    put: BlobPutOptions,
  ): Promise<void> {
    const signal = put.signal;
    const created = await send(
      objectUrl(key, { uploads: "" }),
      {
        method: "POST",
        headers: { "content-type": put.contentType ?? DEFAULT_CONTENT_TYPE },
        ...(signal ? { signal } : {}),
      },
      true,
    );
    if (!created.ok) throw await failure(created, `CreateMultipartUpload ${key}`);
    const uploadId = tag(await created.text(), "UploadId");
    if (!uploadId) throw new BlobStoreError(`CreateMultipartUpload ${key} returned no UploadId`);
    const parts: { number: number; etag: string }[] = [];
    const uploadPart = async (bytes: Uint8Array) => {
      const number = parts.length + 1;
      const response = await putBytes(
        objectUrl(key, { partNumber: String(number), uploadId }),
        bytes,
        {},
        signal,
      );
      if (!response.ok) throw await failure(response, `UploadPart ${number} of ${key}`);
      await response.body?.cancel();
      const etag = response.headers.get("etag");
      if (!etag) throw new BlobStoreError(`UploadPart ${number} of ${key} returned no ETag`);
      parts.push({ number, etag });
    };
    try {
      await uploadPart(first);
      let buffered: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await rest.next();
        if (next.done) break;
        const chunk = next.value;
        signal?.throwIfAborted();
        state.size += chunk.byteLength;
        if (put.maxBytes !== undefined && state.size > put.maxBytes)
          throw new BlobTooLargeError(put.maxBytes);
        state.hash.update(chunk);
        buffered.push(chunk);
        length += chunk.byteLength;
        if (length >= partSize) {
          await uploadPart(concat(buffered, length));
          buffered = [];
          length = 0;
        }
      }
      if (length > 0) await uploadPart(concat(buffered, length));
      const body = `<CompleteMultipartUpload>${parts
        .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
      const completed = await send(
        objectUrl(key, { uploadId }),
        {
          method: "POST",
          body,
          headers: { "content-type": "application/xml", "x-amz-content-sha256": sha256Hex(new TextEncoder().encode(body)) },
          ...(signal ? { signal } : {}),
        },
        true,
      );
      // CompleteMultipartUpload may answer 200 with an error in the body.
      const text = completed.ok ? await completed.text() : "";
      if (!completed.ok) throw await failure(completed, `CompleteMultipartUpload ${key}`);
      if (/<Error>/.test(text))
        throw new BlobStoreError(
          `CompleteMultipartUpload ${key} failed: ${tag(text, "Code") ?? "error"}: ${tag(text, "Message") ?? ""}`,
          completed.status,
          tag(text, "Code"),
        );
    } catch (error) {
      // Best effort: an upload left behind holds only parts, never an object.
      await send(objectUrl(key, { uploadId }), { method: "DELETE" })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
      throw error;
    }
  }

  return {
    kind: "s3",

    async ensureBucket(): Promise<void> {
      const found = await send(bucketUrl, { method: "HEAD" });
      if (found.ok) return;
      if (found.status !== 404) throw await failure(found, `HEAD bucket ${options.bucket}`);
      const region = options.region ?? "us-east-1";
      const body =
        region === "us-east-1"
          ? undefined
          : `<CreateBucketConfiguration><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`;
      const created = await send(bucketUrl, {
        method: "PUT",
        ...(body
          ? {
              body,
              headers: {
                "content-type": "application/xml",
                "x-amz-content-sha256": sha256Hex(new TextEncoder().encode(body)),
              },
            }
          : {}),
      });
      if (created.ok) {
        await created.body?.cancel();
        return;
      }
      const error = await failure(created, `CreateBucket ${options.bucket}`);
      if (error.code === "BucketAlreadyOwnedByYou" || error.code === "BucketAlreadyExists") return;
      throw error;
    },

    async put(key: string, body: BlobBody, put: BlobPutOptions = {}): Promise<BlobPutResult> {
      assertBlobKey(key);
      assertMaxBytes(put.maxBytes);
      put.signal?.throwIfAborted();
      const state = { size: 0, hash: createHash("sha256") };
      const chunks = chunksOf(body)[Symbol.asyncIterator]();
      // Buffer up to one part: a body that ends first goes in one PutObject.
      const buffered: Uint8Array[] = [];
      let length = 0;
      let ended = false;
      try {
        while (length < partSize) {
          const next = await chunks.next();
          if (next.done) {
            ended = true;
            break;
          }
          put.signal?.throwIfAborted();
          state.size += next.value.byteLength;
          if (put.maxBytes !== undefined && state.size > put.maxBytes)
            throw new BlobTooLargeError(put.maxBytes);
          state.hash.update(next.value);
          buffered.push(next.value);
          length += next.value.byteLength;
        }
        const first = concat(buffered, length);
        if (ended) {
          const response = await putBytes(
            objectUrl(key),
            first,
            { "content-type": put.contentType ?? DEFAULT_CONTENT_TYPE },
            put.signal,
          );
          if (!response.ok) throw await failure(response, `PUT ${key}`);
          await response.body?.cancel();
        } else {
          await putMultipart(key, first, chunks, state, put);
        }
      } catch (error) {
        await chunks.return?.(undefined).catch(() => undefined);
        throw error;
      }
      return { key, size: state.size, sha256: state.hash.digest("hex") };
    },

    async get(key: string, get: BlobGetOptions = {}): Promise<BlobGetResult | undefined> {
      assertBlobKey(key);
      const range: BlobRange | undefined = get.range;
      if (range) assertRange(range);
      const response = await send(objectUrl(key), {
        method: "GET",
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ""}` } } : {}),
        ...(get.signal ? { signal: get.signal } : {}),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status === 416 && range) {
        await response.body?.cancel();
        const total = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
        throw new BlobRangeError(range, total !== undefined ? Number(total) : ((await head(key))?.size ?? 0));
      }
      if (!response.ok || !response.body) throw await failure(response, `GET ${key}`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
        if (!match) {
          await response.body.cancel();
          throw new BlobStoreError(`GET ${key} answered 206 without a Content-Range`);
        }
        const size = match[3] === "*" ? ((await head(key))?.size ?? 0) : Number(match[3]);
        return {
          ...metaOf(key, response.headers, size),
          body: response.body,
          range: { start: Number(match[1]), end: Number(match[2]) },
        };
      }
      // 200: the whole object. A server that ignores Range sends it all too.
      const meta = metaOf(key, response.headers, length);
      if (!range) return { ...meta, body: response.body };
      if (range.start >= length) {
        await response.body.cancel();
        throw new BlobRangeError(range, length);
      }
      if (range.start !== 0) {
        await response.body.cancel();
        throw new BlobStoreError(`GET ${key} ignored the Range header`);
      }
      return { ...meta, body: response.body, range: { start: 0, end: length - 1 } };
    },

    head,

    async delete(key: string): Promise<void> {
      assertBlobKey(key);
      const response = await send(objectUrl(key), { method: "DELETE" });
      if (response.ok || response.status === 404) {
        await response.body?.cancel();
        return;
      }
      throw await failure(response, `DELETE ${key}`);
    },

    async *list(prefix: string): AsyncIterable<BlobListEntry> {
      assertBlobPrefix(prefix);
      let token: string | undefined;
      do {
        const url = new URL(bucketUrl);
        url.searchParams.set("list-type", "2");
        if (prefix !== "") url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const response = await send(url.toString(), { method: "GET" });
        if (!response.ok) throw await failure(response, `ListObjectsV2 ${prefix}`);
        const xml = await response.text();
        for (const entry of blocks(xml, "Contents")) {
          const key = tag(entry, "Key");
          if (key === undefined) continue;
          const modified = tag(entry, "LastModified");
          yield {
            key,
            size: Number(tag(entry, "Size") ?? 0),
            lastModified: modified ? new Date(modified) : new Date(0),
          };
        }
        token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
      } while (token);
    },
  };
}
