/**
 * Our engine's artifact tools (protocol 15), which run here, in the harness, over the Harness
 * API's artifact seam (`artifact.read`, `artifact.write`) and the run's sandbox files:
 *
 * - `read_artifact` (every agent) reads an artifact the session may read in pages: a tool result
 *   the Runtime stored because it was too large to show, a file of an earlier turn. A text file
 *   comes back a page of at most `artifactPageBytes` at a time (escaped as JSON); any other file
 *   goes to the model as a file of the result, and the Model Gate shows it or writes a note. With
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
import {
  READ_ARTIFACT_TOOL,
  SANDBOX_WORKSPACE,
  SAVE_ARTIFACT_TOOL,
  type AgentManifest,
  type JsonObject,
} from "@nylorun/core/define";
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeFor,
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

const ARTIFACTS_INSTRUCTIONS =
  "Use save_artifact to hand the user a file you made: a path in the sandbox, or text you pass as content. " +
  "The user sees it as an artifact of this session and can download it; reply with its name, not its bytes. " +
  "Files you write under /workspace/outputs reach the user too: when your turn ends, they become the session's outputs folder.";

const READ_ARTIFACT_INSTRUCTIONS =
  "A tool result too large to show is saved as an artifact of this session: the result says truncated: true, with its artifactId, its size in bytes and a preview of its start and end. " +
  "Images and other files a tool returns are saved as artifacts too. Use read_artifact to read more of one, a page at a time, only when the preview is not enough. " +
  'Files from earlier turns appear as lines like [Uploaded artifact "name" · <artifactId> v<version> · read_artifact to view]: call read_artifact with that artifactId and version only when you need the file again.';

const SAVE_DESCRIPTION =
  `Save a file as an artifact of this session, for the user to download. Give path (a file in the sandbox; relative paths resolve under ${SANDBOX_WORKSPACE}) or content (text), not both. ` +
  "Returns the artifact's id and version. Pass artifactId to save a new version of an artifact you saved before.";

const SAVE_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    path: { description: "A file in the sandbox.", type: "string", minLength: 1 },
    content: { description: "Text to save instead of a file.", type: "string" },
    name: {
      description: "The artifact's name. Default: the file's name.",
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
    contentType: {
      description: "The media type, e.g. image/png. Default: from the name's extension.",
      type: "string",
      minLength: 1,
    },
    artifactId: {
      description: "Save a new version of this artifact.",
      type: "string",
      minLength: 1,
    },
  },
  additionalProperties: false,
};

function readDescription(pageBytes: number, sandboxed: boolean): string {
  return (
    `Read an artifact of this session, such as a tool result marked truncated or a file from an earlier turn. A text file returns up to ${pageBytes} bytes from offset, ` +
    "with nextOffset while more remains: pass it as offset to read on. An image or another file you can read is shown to you." +
    (sandboxed
      ? ` Pass path to copy the whole artifact into the sandbox instead (relative paths resolve under ${SANDBOX_WORKSPACE}), for a command to use.`
      : "")
  );
}

function readSchema(pageBytes: number, sandboxed: boolean): JsonObject {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        minLength: 1,
        description: "The artifact to read, e.g. a truncated result's artifactId.",
      },
      version: {
        description: "The version to read. Default: the latest.",
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      offset: {
        description: "The byte to start at. Default 0.",
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      length: {
        description: `How many bytes to read. Default and most: ${pageBytes}.`,
        type: "integer",
        minimum: 1,
        maximum: pageBytes,
      },
      ...(sandboxed
        ? {
            path: {
              description: "Copy the artifact to this file in the sandbox instead of reading it.",
              type: "string",
              minLength: 1,
            },
          }
        : {}),
    },
    required: ["artifactId"],
    additionalProperties: false,
  };
}

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
 * The artifact tools our engine offers `agent`, with their instructions: `save_artifact` when it
 * has a sandbox, and `read_artifact`, which takes `path` only then.
 */
export function artifactToolsFor(
  agent: Pick<AgentManifest, "runtime">,
  options: ArtifactToolOptions,
): DurableSessionTool[] {
  const sandboxed = agent.runtime?.sandbox !== undefined;
  return [
    ...(sandboxed
      ? [
          {
            name: SAVE_ARTIFACT_TOOL,
            description: SAVE_DESCRIPTION,
            inputSchema: SAVE_SCHEMA,
            instructions: [ARTIFACTS_INSTRUCTIONS],
          },
        ]
      : []),
    {
      name: READ_ARTIFACT_TOOL,
      description: readDescription(options.pageBytes, sandboxed),
      inputSchema: readSchema(options.pageBytes, sandboxed),
      instructions: [READ_ARTIFACT_INSTRUCTIONS],
    },
  ];
}

/**
 * The artifact tools as `hello.features.tools` declares them (R4.2): their widest form, so core
 * journals their calls as tools this harness runs (`harness`).
 */
export function artifactToolDeclarations(
  options: ArtifactToolOptions,
): { name: string; description: string; inputSchema: JsonObject }[] {
  return [
    { name: SAVE_ARTIFACT_TOOL, description: SAVE_DESCRIPTION, inputSchema: SAVE_SCHEMA },
    {
      name: READ_ARTIFACT_TOOL,
      description: readDescription(options.pageBytes, true),
      inputSchema: readSchema(options.pageBytes, true),
    },
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

/** Whether the run's session has a sandbox: its agents share the root's. */
function sandboxed(context: ArtifactToolContext): boolean {
  return (
    context.files !== undefined &&
    (context.run.start.routing.rootManifest as Pick<AgentManifest, "runtime">).runtime?.sandbox !==
      undefined
  );
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
  if (!isText(artifact.contentType))
    // A file the model reads goes to it beside the result (protocol 12); the Model Gate writes a
    // note for a type the Tenant's model does not read.
    return {
      kind: "completed",
      output: about(artifact),
      files: [
        {
          mediaType: artifact.contentType,
          reference: {
            artifactId: artifact.artifactId,
            version: artifact.version,
            name: artifact.name,
            size: artifact.size,
          },
        },
      ],
    };
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
