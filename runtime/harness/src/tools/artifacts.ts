/**
 * Our engine's artifact tools (protocol 15), which run here, in the harness, over the Harness
 * API's artifact seam (`artifact.read`, `artifact.write`) and the run's sandbox files:
 *
 * - `read_artifact` (every agent) reads an artifact the session may read in pages: a tool result
 *   the Runtime stored because it was too large to show, a file of an earlier turn. A text file
 *   comes back a page of at most `artifactPageBytes` at a time (escaped as JSON); any other file
 *   goes to the model as a file of the result when the turn's model reads it (`fileView`), and is
 *   `artifact.unsupported` when it does not. With
 *   a sandbox, `path` copies the artifact into the sandbox instead.
 * - `save_artifact` (with a sandbox) saves a sandbox file, or text the model passes, as an
 *   artifact of the session. Its effect id is the write's key, so a write the harness repeats
 *   answers the version it wrote, and links the artifact to the call (`artifact.created` carries
 *   the call id).
 *
 * The model's tools are ours to name, describe and instruct; the Runtime decides what a run may
 * read and write, and holds the limits. Expected problems (no such artifact, too large, not a
 * file) are failed outcomes the model sees; only the run's own failures throw.
 */
import { READ_ARTIFACT_TOOL, SAVE_ARTIFACT_TOOL } from "@nylorun/core/define";
import {
  ARTIFACTS_READ_TEXT,
  ARTIFACTS_SAVE_TEXT,
  OUTPUTS_AFTER_SAVE_TEXT,
  artifactTools,
} from "@nylorun/core/engine";
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeFor,
  essence,
  isText,
  normalizeContentType,
} from "@nylorun/core/contracts";
import {
  HarnessApiError,
  fromBase64,
  openArtifactWrite,
  readArtifact,
  writeArtifactBytes,
  type ArtifactMeta,
  type ArtifactRequester,
  type ArtifactWriteOptions,
} from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import type { FailedFileOutcome, HarnessFiles, HarnessRun } from "../api/executors.js";
import { textPage } from "./text-page.js";
import { fileView } from "../loop/model/files.js";

/** The harness's configuration of its artifact tools. */
export interface ArtifactToolOptions {
  /** The most bytes one `read_artifact` page holds, escaped as JSON. */
  readonly pageBytes: number;
}

/** True when `name` is one of our engine's artifact tools. */
export function isArtifactTool(name: string | undefined): boolean {
  return name === READ_ARTIFACT_TOOL || name === SAVE_ARTIFACT_TOOL;
}

/**
 * The artifact tools our engine offers an agent that declares nothing (`agent-folder/1`):
 * `save_artifact` when the session has a sandbox, and `read_artifact`, which takes `path` only
 * then. Each runs here (`harness`). One that declares its engine features gets those it names
 * (`engineProjection`).
 */
export function artifactToolsFor(
  sandboxed: boolean,
  options: ArtifactToolOptions,
): DurableSessionTool[] {
  return artifactTools({ read: true, save: sandboxed, sandboxed }, options);
}

/** What the model reads with the artifact tools, in their order, for an agent that declares nothing. */
export function artifactInstructions(sandboxed: boolean): string[] {
  return [
    ...(sandboxed ? [`${ARTIFACTS_SAVE_TEXT} ${OUTPUTS_AFTER_SAVE_TEXT}`] : []),
    ARTIFACTS_READ_TEXT,
  ];
}

/** What an artifact tool runs with. */
export interface ArtifactToolContext extends ArtifactToolOptions {
  readonly channel: ArtifactRequester;
  readonly run: HarnessRun;
  /** The run's sandbox files; undefined where the harness has none. */
  readonly files?: HarnessFiles;
  readonly signal: AbortSignal;
}

type Outcome =
  | {
      readonly kind: "completed";
      readonly output: Record<string, unknown>;
      readonly files?: readonly unknown[];
    }
  | FailedFileOutcome;

const failed = (code: string, message: string): FailedFileOutcome => ({
  kind: "failed",
  code,
  message,
});

/** Runs a call of one of our engine's artifact tools, as its outcome. */
export async function runArtifactTool(
  effect: HostEffect,
  context: ArtifactToolContext,
): Promise<Outcome> {
  try {
    return effect.toolName === SAVE_ARTIFACT_TOOL
      ? await save(effect, context)
      : await read(effect, context);
  } catch (error) {
    // The seam's refusals are the model's to see; anything else is the run's.
    if (error instanceof HarnessApiError) {
      if (error.code === "not_found") return failed("artifact.not_found", error.message);
      if (error.code === "limit_exceeded") return failed("artifact.too_large", error.message);
      if (error.code === "invalid") return failed("artifact.invalid_input", error.message);
    }
    throw error;
  }
}

/** Whether the run's session has a sandbox (`turn.start.agent.sandbox`): its agents share it. */
function sandboxed(context: ArtifactToolContext): boolean {
  return context.files !== undefined && context.run.start.agent?.sandbox !== undefined;
}

function about(artifact: ArtifactMeta) {
  return {
    artifactId: artifact.artifactId,
    version: artifact.version,
    name: artifact.name,
    contentType: artifact.contentType,
    size: artifact.size,
  };
}

interface ReadInput {
  artifactId?: unknown;
  version?: unknown;
  offset?: unknown;
  length?: unknown;
  path?: unknown;
}

const isCount = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

async function read(effect: HostEffect, context: ArtifactToolContext): Promise<Outcome> {
  const { channel, run, pageBytes, signal } = context;
  const input = (effect.input ?? {}) as ReadInput;
  const artifactId = typeof input.artifactId === "string" ? input.artifactId : "";
  const wanted = input.version;
  const offset = input.offset ?? 0;
  const length = input.length ?? pageBytes;
  const path = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  if (
    artifactId === "" ||
    (wanted !== undefined && !isCount(wanted, 1)) ||
    !isCount(offset, 0) ||
    !isCount(length, 1) ||
    length > pageBytes
  )
    return failed(
      "artifact.invalid_input",
      `Give artifactId, a version of 1 or more if any, an offset of 0 or more, and a length of 1 to ${pageBytes}.`,
    );
  const chunkBytes = run.start.limits.chunkBytes;
  const version = typeof wanted === "number" ? { version: wanted } : {};
  if (path !== undefined) {
    if (!sandboxed(context))
      return failed("artifact.no_sandbox", "This session has no sandbox to copy an artifact into.");
    const opened = await readArtifact(channel, {
      runId: run.runId,
      artifactId,
      ...version,
      chunkBytes,
      signal,
    });
    if (opened.artifact.kind !== "file")
      return failed(
        "artifact.not_text",
        `${opened.artifact.name} is a folder; read_artifact reads a file.`,
      );
    const written = await context.files!.write(run, path, opened.chunks(), signal);
    if (written.kind === "failed") return written;
    return { kind: "completed", output: { ...about(opened.artifact), path: written.path } };
  }
  const answer = await channel.request(
    "artifact.read",
    { runId: run.runId, artifactId, ...version, offset, length: Math.min(length, chunkBytes) },
    signal,
  );
  const { artifact } = answer;
  if (artifact.kind !== "file")
    return failed("artifact.not_text", `${artifact.name} is a folder; read_artifact reads a file.`);
  if (!isText(artifact.contentType)) {
    // A file the turn's model reads goes to it beside the result (protocol 12); for one it does
    // not, the model is told why (protocol 15).
    const file = {
      mediaType: artifact.contentType,
      reference: {
        artifactId: artifact.artifactId,
        version: artifact.version,
        name: artifact.name,
        size: artifact.size,
      },
    };
    const view = fileView(file, run.start.model, run.start.limits);
    if (view.kind === "note")
      return failed(
        "artifact.unsupported",
        `${artifact.name} is ${essence(artifact.contentType)}: ${view.why}.`,
      );
    return { kind: "completed", output: about(artifact), files: [file] };
  }
  if (offset > artifact.size || (offset === artifact.size && artifact.size > 0))
    return failed(
      "artifact.invalid_input",
      `Offset ${offset} is past the end of ${artifact.name}, which is ${artifact.size} bytes.`,
    );
  const bytes = fromBase64(answer.base64);
  const page = textPage(bytes, offset + bytes.byteLength >= artifact.size, pageBytes);
  const next = offset + page.bytes;
  return {
    kind: "completed",
    output: {
      ...about(artifact),
      offset,
      content: page.text,
      ...(next < artifact.size ? { nextOffset: next } : {}),
    },
  };
}

interface SaveInput {
  path?: unknown;
  content?: unknown;
  name?: unknown;
  contentType?: unknown;
  artifactId?: unknown;
}

async function save(effect: HostEffect, context: ArtifactToolContext): Promise<Outcome> {
  const { channel, run, signal } = context;
  const input = (effect.input ?? {}) as SaveInput;
  const path = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  const content = typeof input.content === "string" ? input.content : undefined;
  if ((path === undefined) === (content === undefined))
    return failed("artifact.invalid_input", "Give path or content, not both.");
  if (path !== undefined && !sandboxed(context))
    return failed("artifact.no_sandbox", "This session has no sandbox to read a path from.");
  const artifactId = typeof input.artifactId === "string" ? input.artifactId : undefined;
  const name =
    typeof input.name === "string" && input.name !== ""
      ? input.name
      : path !== undefined
        ? basename(path)
        : "artifact.txt";
  let contentType: string;
  if (typeof input.contentType === "string") {
    const declared = normalizeContentType(input.contentType);
    if (declared === undefined)
      return failed("artifact.invalid_input", `${input.contentType} is not a media type.`);
    contentType = declared;
  } else {
    contentType = contentTypeFor(name);
    if (content !== undefined && contentType === DEFAULT_CONTENT_TYPE)
      contentType = "text/plain; charset=utf-8";
  }
  const options: ArtifactWriteOptions = {
    runId: run.runId,
    // The call is the write: a repeat of it answers the version it wrote.
    key: effect.effectId,
    effectId: effect.effectId,
    ...(artifactId !== undefined ? { artifactId } : { name }),
    contentType,
    chunkBytes: run.start.limits.chunkBytes,
    signal,
  };
  if (content !== undefined)
    return saved(await writeArtifactBytes(channel, options, new TextEncoder().encode(content)));
  const upload = await openArtifactWrite(channel, options);
  if (upload.kind === "written") return saved(upload);
  try {
    const file = await context.files!.read(run, path!, upload.maxBytes, signal);
    if (file.kind !== "read") {
      await upload.abort().catch(() => undefined);
      return file.kind === "missing"
        ? failed("artifact.not_found", `${file.path} does not exist in the sandbox.`)
        : file;
    }
    await upload.write(file.bytes);
    return saved(await upload.commit());
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
}

function saved({ artifact }: { readonly artifact: ArtifactMeta }): Outcome {
  return {
    kind: "completed",
    output: {
      artifactId: artifact.artifactId,
      version: artifact.version,
      name: artifact.name,
      contentType: artifact.contentType,
      size: artifact.size,
      sha256: artifact.sha256,
    },
  };
}

/** The last segment of a POSIX path. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
