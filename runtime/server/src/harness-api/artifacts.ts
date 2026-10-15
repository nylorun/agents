/**
 * The artifact seam of the Harness API (protocol 15): a harness reads and writes the artifacts
 * of the run it holds, and nothing else. Our engine's `read_artifact` and `save_artifact` run in
 * the harness over it; any harness may use it.
 *
 * - **Scope.** The run's session (`run.grant.sessionId`), never a parameter: agents used as tools
 *   share it. A read follows the read rule (`sessionMayRead`): the session's own artifacts and the
 *   Tenant-wide ones its messages named. Anything else, missing or not, is the same `not_found`.
 *   A write makes an artifact of the session, or a new version of one of its own file artifacts.
 * - **Chunks.** No answer or chunk carries more than the run's `limits.chunkBytes`: a read is
 *   clamped to it, a chunk past it is `limit_exceeded`.
 * - **Uploads stream.** `begin` starts the upload (`uploadArtifact`) with a body that takes each
 *   chunk as it comes: a chunk is answered once the store took it, so nothing is held whole, and
 *   the version commits in Postgres on `commit` as any upload does. The key of `begin` makes the
 *   write idempotent within the session (`writeKeyOf`, `artifact_versions.write_key`), and its
 *   `effectId` a tool call of the run's turn, whose call id `artifact.created` carries: core reads
 *   it from the journal, so the harness only names the call.
 * - **Ends.** `abort`, the run's end and core's abort of the advance stop an upload: nothing
 *   commits.
 */
import { randomUUID } from "node:crypto";
import { HarnessApiError, type ArtifactMeta, type ParamsOf, type ResultOf } from "@nylorun/core/harness-api";
import { limitExceededMessage, normalizeContentType, type RuntimeLimits } from "@nylorun/core/contracts";
import { isArtifactId } from "@nylorun/core/compatibility";
import type { HostEffect } from "@nylorun/harness/run";
import { BlobRangeError } from "../blob/index.js";
import { sessionMayRead } from "../artifacts/files.js";
import { artifactQuota, artifactUsage, environmentOfSession } from "../artifacts/quota.js";
import {
  artifactRoom,
  checkArtifactName,
  uploadArtifact,
  writeKeyOf,
  type Uploaded,
} from "../artifacts/service.js";
import type { ArtifactRow, ArtifactVersionRow } from "../store/types.js";
import type { Session, TenantContext } from "../tenant/context.js";
import { HttpError } from "../tenant/http.js";
import { toolIds } from "../tenant/transcript.js";
import { abortKind } from "../tenant/worker.js";

/** The run an artifact request is for, as the server holds it. */
export interface ArtifactScope {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The Runtime limits of the run's `turn.start`. */
  readonly limits: RuntimeLimits;
  /** Core's abort of the advance: it stops the run's uploads. */
  readonly runSignal: AbortSignal;
}

export interface ArtifactSeam {
  read(scope: ArtifactScope, params: ParamsOf<"artifact.read">, signal: AbortSignal): Promise<ResultOf<"artifact.read">>;
  write(
    scope: ArtifactScope,
    params: ParamsOf<"artifact.write">,
    signal: AbortSignal,
  ): Promise<ResultOf<"artifact.write">>;
  /** The run ended: its open uploads stop, and nothing of them commits. */
  endRun(runId: string): void;
}

interface Upload {
  readonly id: string;
  readonly maxBytes: number;
  /** Bytes taken so far, and the last chunk's offset and length (a repeat of it is acknowledged). */
  received: number;
  last?: { readonly offset: number; readonly length: number };
  readonly pipe: Pipe;
  readonly controller: AbortController;
  /** The upload, which commits once the pipe closes. */
  readonly done: Promise<Uploaded>;
}

const notOurs = (artifactId: string) =>
  new HarnessApiError("not_found", `Artifact ${artifactId} is not an artifact of this session.`);

export function createArtifactSeam(ctx: TenantContext): ArtifactSeam {
  const uploads = new Map<string, Map<string, Upload>>();

  const stop = (upload: Upload, reason: string) => {
    if (!upload.controller.signal.aborted) upload.controller.abort(new Error(reason));
    upload.pipe.fail(new HarnessApiError("invalid", `The upload ended: ${reason}`));
  };

  const forget = (runId: string, uploadId: string) => {
    const open = uploads.get(runId);
    open?.delete(uploadId);
    if (open?.size === 0) uploads.delete(runId);
  };

  const uploadOf = (scope: ArtifactScope, uploadId: string): Upload => {
    const upload = uploads.get(scope.runId)?.get(uploadId);
    if (!upload) throw new HarnessApiError("invalid", `No upload ${uploadId} is open for this run`);
    return upload;
  };

  const begin = async (
    scope: ArtifactScope,
    params: Extract<ParamsOf<"artifact.write">, { op: "begin" }>,
    signal: AbortSignal,
  ): Promise<ResultOf<"artifact.write">> => {
    stopped(scope.runSignal);
    const { sessionId, limits } = scope;
    const contentType = params.contentType === undefined ? undefined : normalizeContentType(params.contentType);
    if (params.contentType !== undefined && contentType === undefined)
      throw new HarnessApiError("invalid", `${params.contentType} is not a media type`);
    if (params.artifactId === undefined) harnessError(() => checkArtifactName(params.name));
    const writeKey = writeKeyOf(sessionId, params.key);
    type Begun =
      | { readonly written: ArtifactMeta }
      | {
          readonly written?: undefined;
          readonly owner: string;
          readonly callId: string | undefined;
          readonly room: ReturnType<typeof artifactRoom>;
        };
    const begun = await ctx.store.tx(async (t): Promise<Begun> => {
      // A key written before answers its version: a harness repeating a write stores nothing.
      const known = await t.artifactVersionByWriteKey(writeKey);
      if (known) {
        const row = await t.artifact(known.artifactId);
        if (row) return { written: metaOf(row, known) };
      }
      const session = await t.get<Session>("sessions", sessionId);
      if (!session) throw new HarnessApiError("run_not_held", `Session ${sessionId} is gone`);
      if (params.artifactId !== undefined) {
        const prior = isArtifactId(params.artifactId) ? await t.artifact(params.artifactId) : undefined;
        // A new version only of a file artifact of this session.
        if (!prior || prior.kind !== "file" || prior.sessionId !== sessionId) throw notOurs(params.artifactId);
      }
      let callId: string | undefined;
      if (params.effectId !== undefined) {
        const row = await t.get<{ request: HostEffect }>("effects", params.effectId);
        const request = row?.request;
        if (
          !request ||
          request.kind !== "tool" ||
          request.sessionId !== sessionId ||
          request.turnId !== scope.turnId
        )
          throw new HarnessApiError("invalid", `Effect ${params.effectId} is not a tool call of this run's turn`);
        const ids = toolIds(request.context);
        if ("callId" in ids) callId = ids.callId;
      }
      const quota = await artifactQuota(t, await environmentOfSession(t, sessionId));
      return {
        owner: session.ownerUserId,
        callId,
        room: artifactRoom(quota, await artifactUsage(t, quota)),
      };
    });
    if (begun.written) return { status: "written", artifact: begun.written, created: false };
    const refusal = begun.room.refusal(params.size);
    if (refusal) throw new HarnessApiError("limit_exceeded", `${refusal.message} (limitBytes ${refusal.limitBytes})`);
    const input = {
      ...(params.artifactId === undefined ? { name: params.name! } : { artifactId: params.artifactId }),
      ...(contentType === undefined ? {} : { contentType }),
      sessionId,
      source: "engine" as const,
      turnId: scope.turnId,
      ...(begun.callId === undefined ? {} : { callId: begun.callId }),
      writeKey,
    };
    // Our engine saves into its own session only: the session's owner reaches it.
    const access = { owner: begun.owner };
    if (params.base64 !== undefined) {
      const bytes = chunkOf(params.base64, limits);
      const over = begun.room.refusal(bytes.byteLength);
      if (over) throw new HarnessApiError("limit_exceeded", `${over.message} (limitBytes ${over.limitBytes})`);
      const saved = await harnessErrorOf(uploadArtifact(ctx, { ...input, declaredBytes: bytes.byteLength }, bytes, access, signal));
      return written(saved);
    }
    const controller = new AbortController();
    const pipe = new Pipe();
    const upload: Upload = {
      id: randomUUID(),
      maxBytes: begun.room.maxBytes,
      received: 0,
      pipe,
      controller,
      done: uploadArtifact(
        ctx,
        { ...input, ...(params.size === undefined ? {} : { declaredBytes: params.size }) },
        pipe,
        access,
        controller.signal,
      ),
    };
    // A failed upload fails the chunk waiting on it, and the next request; no rejection is lost.
    upload.done.catch((error: unknown) => pipe.fail(error));
    const open = uploads.get(scope.runId) ?? new Map<string, Upload>();
    uploads.set(scope.runId, open);
    open.set(upload.id, upload);
    // Core's abort of the advance (a cancel, a lost lease) stops the run's uploads.
    if (scope.runSignal.aborted) stop(upload, "the run stopped");
    else scope.runSignal.addEventListener("abort", () => stop(upload, "the run stopped"), { once: true });
    return { status: "open", uploadId: upload.id, maxBytes: upload.maxBytes, received: 0 };
  };

  const chunk = async (
    scope: ArtifactScope,
    params: Extract<ParamsOf<"artifact.write">, { op: "chunk" }>,
  ): Promise<ResultOf<"artifact.write">> => {
    const upload = uploadOf(scope, params.uploadId);
    const open = () => ({ status: "open" as const, uploadId: upload.id, maxBytes: upload.maxBytes, received: upload.received });
    const bytes = chunkOf(params.base64, scope.limits);
    // A repeat of the last chunk (its answer was lost) is acknowledged, not taken again.
    if (
      upload.last &&
      params.offset === upload.last.offset &&
      bytes.byteLength === upload.last.length &&
      params.offset + bytes.byteLength === upload.received
    )
      return open();
    if (params.offset !== upload.received)
      throw new HarnessApiError(
        "invalid",
        `The chunk starts at ${params.offset}; the upload has ${upload.received} bytes, so the next chunk starts there`,
      );
    if (upload.received + bytes.byteLength > upload.maxBytes) {
      const message = `The upload passes the ${upload.maxBytes} bytes it may hold (limitBytes ${upload.maxBytes})`;
      stop(upload, message);
      forget(scope.runId, upload.id);
      await upload.done.catch(() => undefined);
      throw new HarnessApiError("limit_exceeded", message);
    }
    // Taken now, so a repeat sent while this one is written is acknowledged too.
    upload.received += bytes.byteLength;
    upload.last = { offset: params.offset, length: bytes.byteLength };
    try {
      await upload.pipe.push(bytes);
    } catch (error) {
      forget(scope.runId, upload.id);
      // The upload's own refusal (a limit, the session gone) says more than the pipe's.
      throw toHarnessError(await upload.done.then(() => error, (failure: unknown) => failure));
    }
    return open();
  };

  const commit = async (
    scope: ArtifactScope,
    params: Extract<ParamsOf<"artifact.write">, { op: "commit" }>,
  ): Promise<ResultOf<"artifact.write">> => {
    const upload = uploadOf(scope, params.uploadId);
    stopped(scope.runSignal);
    upload.pipe.close();
    try {
      return written(await upload.done);
    } catch (error) {
      throw toHarnessError(error);
    } finally {
      forget(scope.runId, upload.id);
    }
  };

  return {
    async read(scope, params, signal) {
      const { artifactId } = params;
      const found = await ctx.store.tx(async (t) => {
        if (!isArtifactId(artifactId)) return undefined;
        const artifact = await t.artifact(artifactId);
        if (!artifact) return undefined;
        const session = await t.get<Pick<Session, "id" | "fileArtifacts">>("sessions", scope.sessionId);
        if (!sessionMayRead(session, artifact)) return undefined;
        return { artifact, version: await t.artifactVersion(artifact.id, params.version ?? artifact.latestVersion) };
      });
      if (!found) throw notOurs(artifactId);
      const { artifact, version } = found;
      if (!version) throw new HarnessApiError("not_found", `Artifact ${artifactId} has no version ${params.version}.`);
      const meta = metaOf(artifact, version);
      const offset = params.offset ?? 0;
      // A folder's bytes are its files: the seam answers its metadata only.
      if (artifact.kind !== "file") return { artifact: meta, offset, base64: "", eof: true };
      if (offset > version.size)
        throw new HarnessApiError(
          "invalid",
          `Offset ${offset} is past the end of ${artifact.name}, which is ${version.size} bytes.`,
        );
      const { chunkBytes } = scope.limits;
      const end = Math.min(offset + Math.min(params.length ?? chunkBytes, chunkBytes), version.size);
      if (end === offset) return { artifact: meta, offset, base64: "", eof: offset === version.size };
      let bytes: Uint8Array;
      try {
        const got = await ctx.blobs.get(version.blobKey, { range: { start: offset, end: end - 1 }, signal });
        if (!got) throw new HarnessApiError("unavailable", `The bytes of ${artifact.name} are missing from the Object store`);
        bytes = new Uint8Array(await new Response(got.body).arrayBuffer());
      } catch (error) {
        if (!(error instanceof BlobRangeError)) throw error;
        bytes = new Uint8Array();
      }
      return {
        artifact: meta,
        offset,
        base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
        eof: offset + bytes.byteLength >= version.size,
      };
    },
    async write(scope, params, signal) {
      switch (params.op) {
        case "begin":
          return begin(scope, params, signal);
        case "chunk":
          return chunk(scope, params);
        case "commit":
          return commit(scope, params);
        case "abort": {
          const upload = uploads.get(scope.runId)?.get(params.uploadId);
          if (upload) {
            stop(upload, "the harness aborted it");
            forget(scope.runId, upload.id);
            await upload.done.catch(() => undefined);
          }
          return { status: "aborted" };
        }
      }
    },
    endRun(runId) {
      const open = uploads.get(runId);
      if (!open) return;
      uploads.delete(runId);
      for (const upload of open.values()) stop(upload, "the run ended");
    },
  };
}

/** What the seam shows of an artifact's version. */
function metaOf(artifact: ArtifactRow, version: ArtifactVersionRow): ArtifactMeta {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    version: version.version,
    contentType: version.contentType,
    size: version.size,
    sha256: version.sha256,
    tenantWide: artifact.sessionId === null,
  };
}

function written(saved: Uploaded): ResultOf<"artifact.write"> {
  return {
    status: "written",
    artifact: {
      artifactId: saved.artifact.artifactId,
      kind: saved.artifact.kind,
      name: saved.artifact.name,
      version: saved.version.version,
      contentType: saved.version.contentType,
      size: saved.version.size,
      sha256: saved.version.sha256,
      tenantWide: saved.artifact.sessionId === undefined,
    },
    created: saved.created,
  };
}

/** One chunk's bytes, at most the run's `chunkBytes`. */
function chunkOf(base64: string, limits: RuntimeLimits): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > limits.chunkBytes)
    throw new HarnessApiError(
      "limit_exceeded",
      limitExceededMessage("The chunk", bytes.byteLength, "chunkBytes", limits.chunkBytes),
    );
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A stopped run starts no write. */
function stopped(signal: AbortSignal): void {
  const kind = abortKind(signal);
  if (kind === undefined) return;
  if (kind === "cancel") throw new HarnessApiError("turn_cancelled", "Turn cancelled");
  if (kind === "ownership.lost") throw new HarnessApiError("ownership_lost", "The session's lease was lost");
  throw new HarnessApiError("unavailable", "The run is stopping");
}

/**
 * An upload's refusal as the harness hears it: missing or not the session's is `not_found`, past a
 * limit `limit_exceeded`, any other refusal `invalid`. Anything else is the Runtime's own error.
 */
function toHarnessError(error: unknown): unknown {
  if (error instanceof HarnessApiError || !(error instanceof HttpError)) return error;
  if (error.status === 404) return new HarnessApiError("not_found", error.message);
  if (error.status === 413) {
    const limit = (error.rejection.details as { limitBytes?: unknown } | undefined)?.limitBytes;
    return new HarnessApiError(
      "limit_exceeded",
      typeof limit === "number" ? `${error.message} (limitBytes ${limit})` : error.message,
    );
  }
  if (error.status === 400 || error.status === 409) return new HarnessApiError("invalid", error.message);
  return error;
}

function harnessError<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw toHarnessError(error);
  }
}

async function harnessErrorOf<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw toHarnessError(error);
  }
}

/**
 * The body of an upload: chunks handed over one at a time. `push` resolves once the store took
 * the chunk, so a harness's next chunk waits for the store (backpressure across frames, nothing
 * held whole); `close` ends the body, `fail` ends it with an error on both sides.
 */
class Pipe implements AsyncIterable<Uint8Array> {
  private taker?: { resolve(result: IteratorResult<Uint8Array>): void; reject(error: unknown): void };
  private offered?: { bytes: Uint8Array; taken(): void; reject(error: unknown): void };
  private ended = false;
  private error?: { value: unknown };

  push(bytes: Uint8Array): Promise<void> {
    if (this.error) return Promise.reject(this.error.value);
    if (this.ended) return Promise.reject(new HarnessApiError("invalid", "The upload is committing"));
    if (this.taker) {
      const taker = this.taker;
      this.taker = undefined;
      taker.resolve({ value: bytes, done: false });
      return Promise.resolve();
    }
    return new Promise((taken, reject) => {
      this.offered = { bytes, taken, reject };
    });
  }

  close(): void {
    this.ended = true;
    if (this.taker && !this.offered) {
      const taker = this.taker;
      this.taker = undefined;
      taker.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.error) return;
    this.error = { value: error };
    this.offered?.reject(error);
    this.offered = undefined;
    this.taker?.reject(error);
    this.taker = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.error) return Promise.reject(this.error.value);
        if (this.offered) {
          const { bytes, taken } = this.offered;
          this.offered = undefined;
          taken();
          return Promise.resolve({ value: bytes, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.taker = { resolve, reject };
        });
      },
      return: () => {
        this.fail(new HarnessApiError("invalid", "The store stopped reading the upload"));
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
