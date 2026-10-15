/**
 * A harness's side of the artifact seam (protocol 15): reading an artifact the run's session may
 * read in chunks (`artifact.read`), and writing one (`artifact.write`: `begin`, `chunk`,
 * `commit`, `abort`). Chunks are at most `chunkBytes`: pass the run's
 * `turn.start.limits.chunkBytes`, which core holds them to. Our engine's `read_artifact` and
 * `save_artifact` use these, and any harness may.
 */
import type { HarnessChannel } from "./rpc.js";
import type { ArtifactMeta, ParamsOf, ResultOf } from "./messages.js";

/** What the helpers need of a channel: its requests to core. */
export type ArtifactRequester = Pick<HarnessChannel, "request">;

export interface ReadArtifactOptions {
  readonly runId: string;
  readonly artifactId: string;
  /** Default: the latest, which the first answer pins for the chunks after it. */
  readonly version?: number;
  /** The first byte to read. Default 0. */
  readonly offset?: number;
  /** The most bytes each request asks for: the run's `turn.start.limits.chunkBytes`. */
  readonly chunkBytes: number;
  readonly signal?: AbortSignal;
}

export interface ReadArtifact {
  readonly artifact: ArtifactMeta;
  /**
   * The bytes from `offset` to the end, a chunk at a time: the first came with `artifact`, the
   * rest are asked for as they are read. Read it once.
   */
  chunks(): AsyncIterable<Uint8Array>;
}

/** Opens an artifact to read: its metadata, and its bytes as chunks. */
export async function readArtifact(channel: ArtifactRequester, options: ReadArtifactOptions): Promise<ReadArtifact> {
  const { runId, artifactId, chunkBytes, signal } = options;
  const start = options.offset ?? 0;
  const first = await channel.request(
    "artifact.read",
    {
      runId,
      artifactId,
      ...(options.version === undefined ? {} : { version: options.version }),
      offset: start,
      length: chunkBytes,
    },
    signal
  );
  // The chunks after the first read the version the first did, even if a newer one lands.
  const version = first.artifact.version;
  return {
    artifact: first.artifact,
    async *chunks() {
      let answer = first;
      let offset = start;
      for (;;) {
        const bytes = fromBase64(answer.base64);
        if (bytes.byteLength > 0) yield bytes;
        offset += bytes.byteLength;
        if (answer.eof || bytes.byteLength === 0) return;
        answer = await channel.request(
          "artifact.read",
          { runId, artifactId, version, offset, length: chunkBytes },
          signal
        );
      }
    },
  };
}

export interface ArtifactWriteOptions {
  readonly runId: string;
  /** Makes the write idempotent within the session: a key written before answers its version. */
  readonly key: string;
  /** A new artifact's name. */
  readonly name?: string;
  /** Write a new version of this artifact of the session instead. */
  readonly artifactId?: string;
  /** Default: what the name's extension implies. */
  readonly contentType?: string;
  /** The tool call the artifact comes from: an effect of the run's turn. */
  readonly effectId?: string;
  /** The body's size when known: core refuses one past its limits before a byte is sent. */
  readonly size?: number;
  /** The most bytes one chunk carries: the run's `turn.start.limits.chunkBytes`. */
  readonly chunkBytes: number;
  readonly signal?: AbortSignal;
}

/** A version `artifact.write` stored, and whether this write stored it (not an earlier one). */
export interface WrittenArtifact {
  readonly artifact: ArtifactMeta;
  readonly created: boolean;
}

/** An upload in progress. */
export interface OpenArtifactWrite {
  readonly kind: "open";
  readonly uploadId: string;
  /** The most bytes the upload may hold, when it opened. */
  readonly maxBytes: number;
  /** Sends `bytes` next, in chunks of at most `chunkBytes`. */
  write(bytes: Uint8Array): Promise<void>;
  /** Stores what was sent as the version. */
  commit(): Promise<WrittenArtifact>;
  /** Drops the upload; nothing is stored. */
  abort(): Promise<void>;
}

/**
 * Begins a write. Answers `written` when the key was written before (nothing more to send), else
 * the open upload.
 */
export async function openArtifactWrite(
  channel: ArtifactRequester,
  options: ArtifactWriteOptions
): Promise<({ readonly kind: "written" } & WrittenArtifact) | OpenArtifactWrite> {
  const answer = await channel.request("artifact.write", beginOf(options), options.signal);
  return opened(channel, options, answer);
}

/**
 * Writes `bytes` as the artifact: in the `begin` when they fit one chunk, else as an upload,
 * which an error aborts.
 */
export async function writeArtifactBytes(
  channel: ArtifactRequester,
  options: ArtifactWriteOptions,
  bytes: Uint8Array
): Promise<WrittenArtifact> {
  if (bytes.byteLength <= options.chunkBytes) {
    const answer = await channel.request(
      "artifact.write",
      { ...beginOf({ ...options, size: bytes.byteLength }), base64: toBase64(bytes) },
      options.signal
    );
    if (answer.status !== "written") throw new Error(`artifact.write answered ${answer.status} to a whole body`);
    return { artifact: answer.artifact, created: answer.created };
  }
  const upload = await openArtifactWrite(channel, { ...options, size: bytes.byteLength });
  if (upload.kind === "written") return { artifact: upload.artifact, created: upload.created };
  try {
    await upload.write(bytes);
    return await upload.commit();
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
}

function beginOf(options: ArtifactWriteOptions): Extract<ParamsOf<"artifact.write">, { op: "begin" }> {
  return {
    runId: options.runId,
    op: "begin",
    key: options.key,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.artifactId === undefined ? {} : { artifactId: options.artifactId }),
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    ...(options.effectId === undefined ? {} : { effectId: options.effectId }),
    ...(options.size === undefined ? {} : { size: options.size }),
  };
}

function opened(
  channel: ArtifactRequester,
  options: ArtifactWriteOptions,
  begun: ResultOf<"artifact.write">
): ({ readonly kind: "written" } & WrittenArtifact) | OpenArtifactWrite {
  if (begun.status === "written") return { kind: "written", artifact: begun.artifact, created: begun.created };
  if (begun.status !== "open") throw new Error(`artifact.write answered ${begun.status} to a begin`);
  const { runId, chunkBytes, signal } = options;
  const { uploadId, maxBytes } = begun;
  let received = begun.received;
  return {
    kind: "open",
    uploadId,
    maxBytes,
    async write(bytes) {
      for (let at = 0; at < bytes.byteLength; at += chunkBytes) {
        const chunk = bytes.subarray(at, Math.min(at + chunkBytes, bytes.byteLength));
        const sent = await channel.request(
          "artifact.write",
          { runId, op: "chunk", uploadId, offset: received, base64: toBase64(chunk) },
          signal
        );
        if (sent.status !== "open") throw new Error(`artifact.write answered ${sent.status} to a chunk`);
        received = sent.received;
      }
    },
    async commit() {
      const done = await channel.request("artifact.write", { runId, op: "commit", uploadId }, signal);
      if (done.status !== "written") throw new Error(`artifact.write answered ${done.status} to a commit`);
      return { artifact: done.artifact, created: done.created };
    },
    async abort() {
      await channel.request("artifact.write", { runId, op: "abort", uploadId });
    },
  };
}

const NodeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;

/** `bytes` as base64. */
export function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  // `fromCharCode` takes its bytes as arguments: a slice at a time keeps under the engine's cap.
  for (let at = 0; at < bytes.byteLength; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The bytes base64 `text` encodes. */
export function fromBase64(text: string): Uint8Array {
  if (NodeBuffer) {
    const decoded = NodeBuffer.from(text, "base64");
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
