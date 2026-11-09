/**
 * `read` of a sandbox file the turn's model reads as media (ADR-139): an image, a PDF, an Office
 * document, audio or video, known by its extension. Our engine runs it here instead of in the
 * sandbox, which reads text: it reads the bytes (`files.read`), stores them as an artifact of the
 * session for the model only (`artifact.write` with `audience: "model"`, keyed by the call), and
 * answers with the file beside a short result, so the model sees it in the turn's files.
 *
 * - **Decided before anything is stored.** A kind the model doesn't read (`fileView`) fails
 *   `sandbox.unreadable`, in words, with no read and no write.
 * - **Checked by its first bytes.** A `.png` that doesn't start like a PNG fails
 *   `sandbox.binary_file`, so the model never sees bytes as an image they aren't.
 * - **No output.** The artifact is the model's: no A2A task file, never listed. The user's files
 *   still come from `save_artifact` and the outputs folder.
 * - **Text is the sandbox's.** Text files and SVG (text the model reads as such) go to the
 *   sandbox's `read` as before; so does everything when the run has no sandbox files.
 */
import {
  contentTypeFor,
  essence,
  inputLabel,
  matchesSignature,
  modelInputOf,
} from "@nylorun/core/contracts";
import type { ToolResultFile } from "@nylorun/core/define";
import {
  HarnessApiError,
  writeArtifactBytes,
  type ArtifactRequester,
} from "@nylorun/core/harness-api";
import { fileView } from "../loop/model/files.js";
import type { HostEffect } from "../run/durable.js";
import type { FailedFileOutcome, HarnessFiles, HarnessRun } from "../api/executors.js";

/** The sandbox operation this module takes over for media files. */
const READ = "read";

export interface MediaReadContext {
  readonly channel: ArtifactRequester;
  readonly run: HarnessRun;
  readonly files: HarnessFiles;
  readonly signal: AbortSignal;
}

type Outcome =
  | {
      readonly kind: "completed";
      readonly output: {
        readonly path: string;
        readonly contentType: string;
        readonly size: number;
      };
      readonly files: readonly ToolResultFile[];
    }
  | FailedFileOutcome;

const failed = (code: string, message: string): FailedFileOutcome => ({
  kind: "failed",
  code,
  message,
});

/** The path and media type of a `read` call our engine runs as media, or undefined for the sandbox's. */
export function mediaReadOf(
  effect: HostEffect,
): { readonly path: string; readonly contentType: string } | undefined {
  if (effect.kind !== "tool" || effect.target?.kind !== "sandbox" || effect.toolName !== READ)
    return undefined;
  const path = (effect.input as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || path === "") return undefined;
  const contentType = contentTypeFor(path);
  const input = modelInputOf(contentType);
  // Text, SVG (an image no model reads as one, but text it reads) and unknown types: the sandbox's.
  if (input === undefined || input === "text" || essence(contentType) === "image/svg+xml")
    return undefined;
  return { path, contentType };
}

/** The file's name, for the artifact: the last part of its path. */
const nameOf = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** Runs a `read` of a media file (`mediaReadOf`). */
export async function runMediaRead(
  effect: HostEffect,
  target: { readonly path: string; readonly contentType: string },
  context: MediaReadContext,
): Promise<Outcome> {
  const { channel, run, files, signal } = context;
  const { path, contentType } = target;
  const { limits, model } = run.start;
  const name = nameOf(path);
  const kind = inputLabel(modelInputOf(contentType));
  const view = fileView({ mediaType: contentType, reference: { name } }, model, limits);
  if (view.kind === "note")
    return failed(
      "sandbox.unreadable",
      `${path} can't be shown to you: ${view.why}. Describe it from what made it instead.`,
    );
  const read = await files.read(run, path, limits.modelFileBytes, signal);
  if (read.kind === "missing") return failed("sandbox.not_found", `No file at ${read.path}`);
  if (read.kind === "failed") return read;
  const { bytes } = read;
  if (matchesSignature(contentType, bytes) === false)
    return failed(
      "sandbox.binary_file",
      `${read.path} doesn't start like the ${kind} its name says, so it isn't shown. Check how it was made.`,
    );
  try {
    const { artifact } = await writeArtifactBytes(
      channel,
      {
        runId: run.runId,
        // The call is the write: a repeat of it answers the version it stored.
        key: effect.effectId,
        effectId: effect.effectId,
        name,
        contentType,
        audience: "model",
        chunkBytes: limits.chunkBytes,
        signal,
      },
      bytes,
    );
    return {
      kind: "completed",
      output: { path: read.path, contentType, size: artifact.size },
      files: [
        {
          mediaType: contentType,
          reference: {
            artifactId: artifact.artifactId,
            version: artifact.version,
            name,
            size: artifact.size,
          },
        },
      ],
    };
  } catch (error) {
    // A quota is the Tenant's to raise: the model learns why it can't look.
    if (error instanceof HarnessApiError && error.code === "limit_exceeded")
      return failed("sandbox.too_large", `${path} can't be shown to you: ${error.message}`);
    throw error;
  }
}
