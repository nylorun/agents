/**
 * A folder version a harness writes over the artifact seam (`artifact.write` with
 * `kind: "folder"`, protocol 15): our engine's outputs folder, or any harness's. The harness
 * sends each file (`file`, then `chunk`s naming it by hash), and `commit` stores the version
 * (`commitFolderVersion`) with its content epoch, quotas and dedupe.
 *
 * - **No existence oracle.** Core takes every byte of every file. A file whose content the store
 *   already holds (or this upload took already) is hashed and its bytes dropped; any other is
 *   streamed to a key of its own, and copied to its content-addressed key (`contentKey`) only
 *   once its hash is checked. Answering "already stored" would let a session name content it
 *   does not hold; writing to the content key before the check would let a false hash replace
 *   another session's file.
 * - **A hash that does not match** ends the upload: what it stored is collected, and the file's
 *   request is `invalid`.
 * - **Unchanged.** A version whose files are the folder's latest is not added: `commit` answers
 *   that version, `unchanged`.
 * - **Bounded.** At most `limits.folderEntries` files, each within the Tenant's per-file limit,
 *   together within its totals' limits (`commit` checks the room after dedupe, and answers
 *   `refused` past one).
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import { posix } from "node:path";
import {
  ARTIFACT_PATH_MAX,
  contentTypeFor,
  limitExceededMessage,
  normalizeContentType,
  type FolderEntry,
  type RuntimeLimits,
} from "@nylorun/core/contracts";
import { HarnessApiError, type ParamsOf } from "@nylorun/core/harness-api";
import type { ArtifactRow, ArtifactVersionRow } from "../store/types.js";
import type { TenantContext } from "../tenant/context.js";
import {
  collectContent,
  commitFolderVersion,
  contentKey,
  encodeManifest,
  FolderCommitRefused,
  sha256Hex,
} from "./folders.js";
import { Pipe } from "./pipe.js";
import type { ArtifactQuota } from "./quota.js";

/** What a folder upload writes: the session's folder, and what its version must fit. */
export interface FolderTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly name: string;
  /** The folder this upload adds a version to; absent: a new folder. */
  readonly prior?: { readonly row: ArtifactRow; readonly latest?: ArtifactVersionRow };
  readonly quota: ArtifactQuota;
  /** The content epoch read at `begin`, before any `head` of this upload. */
  readonly epoch: number;
  readonly writeKey: string;
  readonly limits: RuntimeLimits;
}

/** How a folder upload's `commit` ended. */
export type FolderCommit =
  | {
      readonly kind: "written";
      readonly row: ArtifactRow;
      readonly version: ArtifactVersionRow;
      readonly created: boolean;
      readonly unchanged?: true;
    }
  | {
      readonly kind: "refused";
      readonly reason: "tenant_total" | "environment_total";
      readonly message: string;
      readonly limit: number;
    };

/** One file being received. */
interface Receiving {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly hash: Hash;
  received: number;
  last?: { readonly offset: number; readonly length: number };
  /** Bytes the store does not hold yet go to a key of their own, until their hash is checked. */
  readonly sink?: { readonly key: string; readonly pipe: Pipe; readonly done: Promise<unknown> };
}

const invalid = (message: string) => new HarnessApiError("invalid", message);

/** A folder file's path: relative, `/`-separated, without empty, `.` or `..` segments. */
export function checkFolderPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length > ARTIFACT_PATH_MAX ||
    path.startsWith("/") ||
    /[\\\u0000-\u001f\u007f]/u.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw invalid(`${JSON.stringify(path)} is not a path in a folder: relative, /-separated, no . or .. segments`);
}

export class FolderUpload {
  readonly id = randomUUID();
  /** The most bytes its files may hold together, and one file. */
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  private readonly entries: FolderEntry[] = [];
  private readonly paths = new Set<string>();
  /** Content taken whole and checked in this upload. */
  private readonly taken = new Set<string>();
  /** Content this upload stored at its content key: collected again if nothing commits. */
  private readonly stored: string[] = [];
  private bytes = 0;
  private files = 0;
  private current?: Receiving;
  private ended = false;

  constructor(
    private readonly ctx: TenantContext,
    readonly target: FolderTarget,
  ) {
    this.maxBytes = Math.min(...target.quota.totals.map((total) => total.limitBytes));
    this.maxFileBytes = target.quota.fileBytes;
    this.maxEntries = target.limits.folderEntries;
  }

  /** Starts a file; its bytes come with it (`base64`) or in `chunk`s. Answers the bytes received. */
  async file(params: Extract<ParamsOf<"artifact.write">, { op: "file" }>, signal: AbortSignal): Promise<number> {
    this.live();
    if (this.current) throw invalid(`${this.current.path} has ${this.current.received} of its ${this.current.size} bytes; send the rest first`);
    checkFolderPath(params.path);
    if (this.paths.has(params.path)) throw invalid(`The folder has ${params.path} already`);
    if (this.entries.length >= this.maxEntries)
      throw new HarnessApiError(
        "limit_exceeded",
        limitExceededMessage("The folder", this.entries.length + 1, "folderEntries", this.maxEntries),
      );
    if (params.size > this.maxFileBytes)
      throw new HarnessApiError(
        "limit_exceeded",
        `${params.path} is ${params.size} bytes; a file may hold at most ${this.maxFileBytes} (limitBytes ${this.maxFileBytes})`,
      );
    if (this.bytes + params.size > this.maxBytes)
      throw new HarnessApiError(
        "limit_exceeded",
        `The folder would hold ${this.bytes + params.size} bytes; it may hold at most ${this.maxBytes} (limitBytes ${this.maxBytes})`,
      );
    const contentType =
      normalizeContentType(params.contentType) ?? contentTypeFor(posix.basename(params.path));
    const known = this.taken.has(params.sha256) || (await this.ctx.blobs.head(contentKey(params.sha256))) !== undefined;
    let sink: Receiving["sink"];
    if (!known) {
      const pipe = new Pipe();
      const key = `artifacts/uploads/${this.id}/${(this.files += 1)}`;
      const done = this.ctx.blobs.put(key, pipe, { contentType, maxBytes: params.size, signal });
      // A failed put fails the chunk waiting on it; no rejection is lost.
      done.catch((error: unknown) => pipe.fail(error));
      sink = { key, pipe, done };
    }
    this.paths.add(params.path);
    this.bytes += params.size;
    this.current = {
      path: params.path,
      size: params.size,
      sha256: params.sha256,
      contentType,
      hash: createHash("sha256"),
      received: 0,
      ...(sink ? { sink } : {}),
    };
    if (params.base64 !== undefined && params.base64 !== "") return this.take(0, params.base64);
    if (params.size === 0) await this.finish();
    return this.current?.received ?? 0;
  }

  /** Bytes of the file in progress from `offset`. Answers the bytes received of it. */
  async chunk(params: Extract<ParamsOf<"artifact.write">, { op: "chunk" }>): Promise<number> {
    this.live();
    const current = this.current;
    if (!current || params.sha256 !== current.sha256) {
      // A repeat of a file's last chunk whose answer was lost: that file is complete.
      if (params.sha256 !== undefined && this.taken.has(params.sha256)) return 0;
      throw invalid(`No file ${params.sha256 ?? "(unnamed)"} is in progress in this upload`);
    }
    return this.take(params.offset, params.base64);
  }

  /** Stores the version, unless it is the folder's latest; collects what it stored when not. */
  async commit(signal: AbortSignal): Promise<FolderCommit> {
    this.live();
    if (this.current)
      throw invalid(`${this.current.path} has ${this.current.received} of its ${this.current.size} bytes`);
    if (this.entries.length === 0) throw invalid("A folder version holds at least one file");
    this.ended = true;
    const { target } = this;
    const latest = target.prior?.latest;
    if (latest !== undefined && sha256Hex(encodeManifest(this.entries)) === latest.sha256)
      return { kind: "written", row: target.prior!.row, version: latest, created: false, unchanged: true };
    try {
      signal.throwIfAborted();
      const { artifact, version } = await commitFolderVersion(this.ctx, {
        sessionId: target.sessionId,
        turnId: target.turnId,
        ...(target.prior ? { artifactId: target.prior.row.id } : {}),
        name: target.name,
        entries: this.entries,
        epoch: target.epoch,
        quota: target.quota,
        source: "engine",
        writeKey: target.writeKey,
      });
      return { kind: "written", row: artifact, version, created: true };
    } catch (error) {
      await this.collect();
      if (error instanceof FolderCommitRefused) {
        if ((error.reason === "tenant_total" || error.reason === "environment_total") && error.limit !== undefined)
          return { kind: "refused", reason: error.reason, message: error.message, limit: error.limit };
        throw invalid(error.message);
      }
      throw error;
    }
  }

  /** Ends the upload: nothing commits, and what it stored is collected. Never throws. */
  async abort(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.dropCurrent(reason);
    await this.collect().catch(() => undefined);
  }

  private live(): void {
    if (this.ended) throw invalid("The upload ended");
  }

  private async take(offset: number, base64: string): Promise<number> {
    const current = this.current!;
    const bytes = chunkOf(base64, this.target.limits);
    // A repeat of the last chunk (its answer was lost) is acknowledged, not taken again.
    if (
      current.last &&
      offset === current.last.offset &&
      bytes.byteLength === current.last.length &&
      offset + bytes.byteLength === current.received
    )
      return current.received;
    if (offset !== current.received)
      throw invalid(
        `The chunk starts at ${offset}; ${current.path} has ${current.received} bytes, so the next chunk starts there`,
      );
    if (current.received + bytes.byteLength > current.size)
      throw invalid(`${current.path} is ${current.size} bytes; this chunk passes its end`);
    current.received += bytes.byteLength;
    current.last = { offset, length: bytes.byteLength };
    current.hash.update(bytes);
    if (current.sink) {
      try {
        await current.sink.pipe.push(bytes);
      } catch (error) {
        await this.abort("the store refused the file");
        throw error;
      }
    }
    if (current.received === current.size) await this.finish();
    return current.received;
  }

  /** The file in progress is whole: check its hash, then keep its content once. */
  private async finish(): Promise<void> {
    const current = this.current!;
    this.current = undefined;
    const { sink } = current;
    try {
      if (sink) {
        sink.pipe.close();
        await sink.done;
      }
      if (current.hash.digest("hex") !== current.sha256) {
        await this.abort("a file's bytes did not match its hash");
        throw invalid(`The bytes of ${current.path} do not match its sha256 ${current.sha256}`);
      }
      if (sink && !this.taken.has(current.sha256)) {
        const key = contentKey(current.sha256);
        if (!(await this.ctx.blobs.head(key))) {
          const got = await this.ctx.blobs.get(sink.key);
          if (!got) throw new Error(`The upload of ${current.path} is missing from the Object store`);
          this.stored.push(current.sha256);
          await this.ctx.blobs.put(key, got.body, { contentType: current.contentType });
        }
      }
    } catch (error) {
      if (!this.ended) await this.abort("a file could not be stored");
      throw error;
    } finally {
      if (sink) await this.ctx.blobs.delete(sink.key).catch(() => undefined);
    }
    this.taken.add(current.sha256);
    this.entries.push({
      path: current.path,
      size: current.size,
      sha256: current.sha256,
      contentType: current.contentType,
    });
  }

  private async dropCurrent(reason: string): Promise<void> {
    const current = this.current;
    this.current = undefined;
    const sink = current?.sink;
    if (!sink) return;
    sink.pipe.fail(invalid(`The upload ended: ${reason}`));
    await sink.done.catch(() => undefined);
    await this.ctx.blobs.delete(sink.key).catch(() => undefined);
  }

  /** Content this upload stored that no committed version names is removed again. */
  private async collect(): Promise<void> {
    if (this.stored.length === 0) return;
    const shas = this.stored.splice(0);
    await this.ctx.store.tx(async (t) => {
      await t.lockArtifactQuota();
      await collectContent(this.ctx.blobs, t, shas);
    });
  }
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
