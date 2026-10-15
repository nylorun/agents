/**
 * Our engine's outputs folder (protocol 15, Q5): a convention of our engine, not of the Runtime.
 * When an agent's segment ends its turn `completed` in a session with a sandbox, our engine saves
 * the files under its outputs directory (`/workspace/outputs` by default) as a version of the
 * session's folder artifact `outputs`, over the artifact seam (`artifact.write` with
 * `kind: "folder"`): the first save makes the folder, later turns add versions, and a turn whose
 * outputs did not change adds none (the seam answers `unchanged`).
 *
 * - **Before the turn ends.** It runs before `turn.completed`, while the run is held, so the next
 *   turn cannot change the workspace under it. A slow save delays the turn's end, bounded by
 *   `OutputsConfig.maxBytes`.
 * - **Never fails the turn.** A limit met is claimed as `artifact.export.skipped` (why, and the
 *   limit), any other failure as `artifact.export.failed`; the turn completes either way.
 * - **Bounded.** At most `limits.folderEntries` files (the Runtime limit), each within the
 *   seam's per-file limit, all within `maxBytes` and the seam's total.
 * - **Idempotent.** The write's key is the turn's (`outputs:<turnId>`): a run that saves again
 *   after a takeover stores nothing new.
 *
 * Nothing in the directory, no directory, or a sandbox never created saves nothing and claims
 * nothing. A harness of your own saves no outputs folder unless it writes one.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  OUTPUTS_ARTIFACT_NAME,
  contentTypeFor,
  type ArtifactExportSkipReason,
} from "@nylorun/core/contracts";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import { toBase64, type HarnessChannel } from "@nylorun/core/harness-api";
import type { HarnessFiles, HarnessRun } from "../api/executors.js";

/** Where our engine finds a turn's outputs, and the most bytes one save stores. */
export interface OutputsConfig {
  /** The directory saved, absolute in the sandbox. */
  readonly dir: string;
  /** The most bytes of files one save reads and sends (before the seam's dedupe). */
  readonly maxBytes: number;
}

/** The outputs folder by default: `/workspace/outputs`, at most 1 GiB a turn. */
export const DEFAULT_OUTPUTS_CONFIG: OutputsConfig = Object.freeze({
  dir: `${SANDBOX_WORKSPACE}/outputs`,
  maxBytes: 1024 * 1024 * 1024,
});

/** The outputs configuration: `set`, with the default for each field it leaves out. */
export function outputsConfigOf(set: Partial<OutputsConfig> | undefined): OutputsConfig {
  return { ...DEFAULT_OUTPUTS_CONFIG, ...set };
}

/** What a save runs with. */
export interface OutputsContext {
  readonly channel: Pick<HarnessChannel, "request">;
  readonly run: HarnessRun;
  readonly files: HarnessFiles;
  readonly config: OutputsConfig;
  readonly signal: AbortSignal;
}

/** Stops the save with `artifact.export.failed`: the sandbox or the seam failed, with its code. */
class SaveFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Stops the save with `artifact.export.skipped`. */
class Skip extends Error {
  constructor(
    readonly reason: ArtifactExportSkipReason,
    message: string,
    readonly limit?: number,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** Saves the run's outputs folder, claiming why when it stores nothing. Never throws. */
export async function saveOutputs(context: OutputsContext): Promise<void> {
  try {
    await save(context);
  } catch (error) {
    if (context.signal.aborted) return;
    const payload =
      error instanceof Skip
        ? {
            name: OUTPUTS_ARTIFACT_NAME,
            reason: error.reason,
            message: error.message,
            ...(error.limit === undefined ? {} : { limit: error.limit }),
            ...(error.path === undefined ? {} : { path: error.path }),
          }
        : {
            name: OUTPUTS_ARTIFACT_NAME,
            message: error instanceof Error ? error.message : String(error),
          };
    const { run } = context;
    await context.channel
      .request("event", {
        runId: run.runId,
        sessionId: run.grant.sessionId,
        turnId: run.grant.turnId,
        type: error instanceof Skip ? "artifact.export.skipped" : "artifact.export.failed",
        payload,
      })
      .catch(() => undefined);
  }
}

async function save(context: OutputsContext): Promise<void> {
  const { channel, run, files, config, signal } = context;
  const { limits } = run.start;
  const { dir } = config;
  const listing = await files.list(run, dir, limits.folderEntries, signal);
  if (listing.kind === "missing") return;
  if (listing.kind === "failed") throw new SaveFailed(listing.code, listing.message);
  if (listing.entries.length === 0) return;
  if (listing.truncated)
    throw new Skip(
      "too_many_files",
      `${dir} holds more than ${limits.folderEntries} files`,
      limits.folderEntries,
    );
  const runId = run.runId;
  const begun = await channel.request(
    "artifact.write",
    {
      runId,
      op: "begin",
      kind: "folder",
      key: `outputs:${run.grant.turnId}`,
      name: OUTPUTS_ARTIFACT_NAME,
      sameName: true,
    },
    signal,
  );
  // This turn's outputs were saved already (a run that took over): nothing more to store.
  if (begun.status === "written") return;
  if (begun.status !== "open")
    throw new SaveFailed(
      "artifact.unexpected",
      `artifact.write answered ${begun.status} to a begin`,
    );
  const { uploadId } = begun;
  const fileBytes = begun.maxFileBytes ?? begun.maxBytes;
  const maxBytes = Math.min(config.maxBytes, begun.maxBytes);
  try {
    const large = listing.entries.find((entry) => entry.size > fileBytes);
    if (large) throw tooLargeFile(dir, large.path, large.size, fileBytes);
    const listed = listing.entries.reduce((sum, entry) => sum + entry.size, 0);
    if (listed > maxBytes) throw tooLarge(dir, listed, maxBytes);
    let read = 0;
    let sent = 0;
    for (const entry of listing.entries) {
      const got = await files.read(run, posix.join(dir, entry.path), fileBytes, signal);
      // Gone since the listing: the folder is what is there now.
      if (got.kind === "missing") continue;
      if (got.kind === "failed") {
        if (got.code === "artifact.too_large")
          throw tooLargeFile(dir, entry.path, entry.size, fileBytes);
        throw new SaveFailed(got.code, got.message);
      }
      read += got.bytes.byteLength;
      if (read > maxBytes) throw tooLarge(dir, read, maxBytes);
      await sendFile(channel, run, uploadId, entry.path, got.bytes, signal);
      sent += 1;
    }
    // Every file vanished: no version.
    if (sent === 0) {
      await abort(channel, runId, uploadId);
      return;
    }
    const done = await channel.request("artifact.write", { runId, op: "commit", uploadId }, signal);
    if (done.status === "refused") throw new Skip(done.reason, done.message, done.limit);
  } catch (error) {
    await abort(channel, runId, uploadId);
    throw error;
  }
}

/** One file of the folder: whole in its `file` request when it fits one chunk, else in chunks. */
async function sendFile(
  channel: Pick<HarnessChannel, "request">,
  run: HarnessRun,
  uploadId: string,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const runId = run.runId;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunkBytes = run.start.limits.chunkBytes;
  const whole = bytes.byteLength <= chunkBytes;
  await channel.request(
    "artifact.write",
    {
      runId,
      op: "file",
      uploadId,
      path,
      size: bytes.byteLength,
      sha256,
      contentType: contentTypeFor(posix.basename(path)),
      ...(whole && bytes.byteLength > 0 ? { base64: toBase64(bytes) } : {}),
    },
    signal,
  );
  if (whole) return;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes)
    await channel.request(
      "artifact.write",
      {
        runId,
        op: "chunk",
        uploadId,
        sha256,
        offset,
        base64: toBase64(bytes.subarray(offset, offset + chunkBytes)),
      },
      signal,
    );
}

async function abort(channel: Pick<HarnessChannel, "request">, runId: string, uploadId: string) {
  await channel.request("artifact.write", { runId, op: "abort", uploadId }).catch(() => undefined);
}

function tooLargeFile(dir: string, path: string, size: number, limit: number): Skip {
  return new Skip(
    "file_too_large",
    `${dir}/${path} is ${size} bytes; a file may hold at most ${limit}`,
    limit,
    path,
  );
}

function tooLarge(dir: string, bytes: number, limit: number): Skip {
  return new Skip(
    "too_large",
    `${dir} holds ${bytes} bytes; a save stores at most ${limit}`,
    limit,
  );
}
