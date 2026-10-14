/**
 * Our engine's built-in artifact tools, of the `nylorun.artifacts` capability
 * (`sandbox/session-sandbox.ts`). The Runtime runs them itself, like the sandbox tools.
 *
 * `save_artifact` (F8.1), which comes with a session's sandbox, saves a file as an artifact of
 * its session:
 * - `path`: a file in the session's sandbox, read as bytes in the sandbox's queue;
 * - `content`: text the model passes.
 * The version commits with `artifact.created` (or `artifact.version.created`) on the session's
 * stream, carrying the turn and the tool call.
 *
 * `read_artifact` (R2b C11, Q24; every agent since protocol 12) reads a text artifact in pages of
 * at most 32 KiB, from a byte `offset`: how the model reads a tool result the Runtime stored
 * because it was too large to show (`tool-results.ts`), and a file of an earlier turn again, by
 * its reference line. Another file is shown as a file of the result when the Tenant's model reads
 * its type, and refused (`artifact.unsupported`) when it does not. It reaches the session's own
 * artifacts and the Tenant-wide ones its messages named (`Session.fileArtifacts`), never another
 * session's. `version` picks a version; the latest by default.
 *
 * Expected problems (no such file, too large, the Tenant's total reached, not text) are failed
 * outcomes the model sees; only infrastructure errors throw.
 */
import { basename } from "node:path";
import type { SandboxToolOutcome } from "@nylorun/core/contracts";
import {
  READ_ARTIFACT_MAX_BYTES,
  SANDBOX_CAPABILITY_ID,
  type ToolResultFile,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { isArtifactId } from "@nylorun/core/compatibility";
import { readArtifactLimits } from "../artifacts/config.js";
import {
  contentTypeFor,
  essence,
  isText,
  normalizeContentType,
  unreadableReason,
} from "../artifacts/media-types.js";
import { currentModelInputs } from "../model/catalog.js";
import { uploadArtifact } from "../artifacts/service.js";
import { DEFAULT_CONTENT_TYPE } from "../blob/index.js";
import { sandboxCapabilityOf } from "../sandbox/manager.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { sessionOf, type TenantContext } from "./context.js";
import { HttpError } from "./http.js";
import { manifestFor } from "./session.js";
import { jsonBytes, utf8Boundary } from "./tool-results.js";
import { toolIds } from "./transcript.js";

export { isReadArtifactCall, isSaveArtifactCall } from "../harness/calls.js";

const failed = (code: string, message: string): SandboxToolOutcome => ({
  kind: "failed",
  code,
  message,
});

interface SaveInput {
  path?: unknown;
  content?: unknown;
  name?: unknown;
  contentType?: unknown;
  artifactId?: unknown;
}

export async function callSaveArtifact(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
): Promise<SandboxToolOutcome> {
  const input = (request.input ?? {}) as SaveInput;
  const path = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  const content = typeof input.content === "string" ? input.content : undefined;
  if ((path === undefined) === (content === undefined))
    return failed("artifact.invalid_input", "Give path or content, not both.");
  const artifactId = typeof input.artifactId === "string" ? input.artifactId : undefined;
  const { s, workspace, limits, ours } = await ctx.store.tx(async (t) => {
    const s = await sessionOf(t, request.sessionId);
    // A new version only of an artifact of this session.
    const ours =
      artifactId === undefined ||
      (isArtifactId(artifactId) && (await t.artifact(artifactId))?.sessionId === s.id);
    return {
      s,
      workspace: sandboxWorkspaceOf(s),
      limits: await readArtifactLimits(t),
      ours,
    };
  });
  if (!ours) return failed("artifact.not_found", `Artifact ${artifactId} is not an artifact of this session.`);

  let bytes: Uint8Array;
  let fileName: string;
  if (path !== undefined) {
    const capability = sandboxCapabilityOf(
      manifestFor(s.manifest, request.agent),
      SANDBOX_CAPABILITY_ID,
      "read",
    );
    if (!capability) return failed("artifact.no_sandbox", "This session has no sandbox to read a path from.");
    const read = await ctx.sandbox.readBytes(
      {
        id: workspace.ownerId,
        activeTurnId: s.activeTurnId,
        manifest: s.manifest,
        ...(workspace.environmentId === undefined ? {} : { environmentId: workspace.environmentId }),
      },
      capability,
      path,
      limits.fileBytes,
      signal,
    );
    if (read.kind === "failed") return read;
    if (read.kind === "missing") return failed("artifact.not_found", `${read.path} does not exist in the sandbox.`);
    bytes = read.bytes;
    fileName = basename(read.path);
  } else {
    bytes = new TextEncoder().encode(content);
    fileName = "artifact.txt";
  }
  const name = typeof input.name === "string" && input.name !== "" ? input.name : fileName;
  let contentType: string;
  if (typeof input.contentType === "string") {
    const declared = normalizeContentType(input.contentType);
    if (declared === undefined)
      return failed("artifact.invalid_input", `${input.contentType} is not a media type.`);
    contentType = declared;
  } else {
    contentType = contentTypeFor(name);
    if (content !== undefined && contentType === DEFAULT_CONTENT_TYPE) contentType = "text/plain; charset=utf-8";
  }
  const ids = toolIds(request.context);
  try {
    const saved = await uploadArtifact(
      ctx,
      {
        ...(artifactId !== undefined ? { artifactId } : { name }),
        contentType,
        sessionId: s.id,
        source: "engine",
        turnId: request.turnId,
        ...("callId" in ids ? { callId: ids.callId } : {}),
      },
      bytes,
      // Our engine saves into its own session only.
      { owner: s.ownerUserId },
      signal,
    );
    return {
      kind: "completed",
      output: {
        artifactId: saved.artifact.artifactId,
        version: saved.version.version,
        name: saved.artifact.name,
        contentType: saved.version.contentType,
        size: saved.version.size,
        sha256: saved.version.sha256,
      },
    };
  } catch (error) {
    if (error instanceof HttpError)
      return failed(
        error.rejection.code === "limit_exceeded" ? "artifact.too_large" : "artifact.rejected",
        error.message,
      );
    throw error;
  }
}

interface ReadInput {
  artifactId?: unknown;
  version?: unknown;
  offset?: unknown;
  length?: unknown;
}

/** What `read_artifact` returns: a page of a text artifact, or a file the model reads. */
interface ReadOutcome {
  readonly kind: "completed";
  readonly output: Record<string, unknown>;
  readonly files?: readonly ToolResultFile[];
}

export async function callReadArtifact(
  ctx: TenantContext,
  request: HostEffect,
  signal: AbortSignal,
): Promise<ReadOutcome | SandboxToolOutcome> {
  const input = (request.input ?? {}) as ReadInput;
  const artifactId = typeof input.artifactId === "string" ? input.artifactId : "";
  const wanted = input.version;
  const offset = input.offset ?? 0;
  const length = input.length ?? READ_ARTIFACT_MAX_BYTES;
  if (
    artifactId === "" ||
    (wanted !== undefined &&
      (typeof wanted !== "number" || !Number.isSafeInteger(wanted) || wanted < 1)) ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > READ_ARTIFACT_MAX_BYTES
  )
    return failed(
      "artifact.invalid_input",
      `Give artifactId, a version of 1 or more if any, an offset of 0 or more, and a length of 1 to ${READ_ARTIFACT_MAX_BYTES}.`,
    );
  const found = await ctx.store.tx(async (t) => {
    const s = await sessionOf(t, request.sessionId);
    if (!isArtifactId(artifactId)) return undefined;
    // An artifact of this session, or a Tenant-wide one its messages named; never another
    // session's.
    const artifact = await t.artifact(artifactId);
    if (
      !artifact ||
      (artifact.sessionId !== s.id &&
        !(artifact.sessionId === null && s.fileArtifacts?.includes(artifact.id)))
    )
      return undefined;
    const version = await t.artifactVersion(
      artifact.id,
      typeof wanted === "number" ? wanted : artifact.latestVersion,
    );
    return { artifact, version };
  });
  if (!found)
    return failed("artifact.not_found", `Artifact ${artifactId} is not an artifact of this session.`);
  if (!found.version)
    return failed("artifact.not_found", `Artifact ${artifactId} has no version ${String(wanted)}.`);
  const { artifact, version } = found;
  const about = {
    artifactId: artifact.id,
    version: version.version,
    name: artifact.name,
    contentType: version.contentType,
    size: version.size,
  };
  if (artifact.kind !== "file")
    return failed("artifact.not_text", `${artifact.name} is a folder; read_artifact reads a file.`);
  if (!isText(version.contentType)) {
    // A file the Tenant's model reads goes to it beside the result (protocol 12). Without a
    // model in the vault (a test's fake provider), text and images.
    const inputs = (await currentModelInputs(ctx)) ?? ["text", "image"];
    const reason = unreadableReason(version.contentType, inputs);
    if (reason)
      return failed(
        "artifact.unsupported",
        `${artifact.name} is ${essence(version.contentType)}: ${reason}.`,
      );
    return {
      kind: "completed",
      output: about,
      files: [
        {
          mediaType: version.contentType,
          reference: {
            artifactId: artifact.id,
            version: version.version,
            name: artifact.name,
            size: version.size,
          },
        },
      ],
    };
  }
  if (offset > version.size || (offset === version.size && version.size > 0))
    return failed(
      "artifact.invalid_input",
      `Offset ${offset} is past the end of ${artifact.name}, which is ${version.size} bytes.`,
    );
  const end = Math.min(offset + length, version.size);
  const bytes =
    end === offset ? new Uint8Array() : await readRange(ctx, version.blobKey, offset, end - 1, signal);
  const page = textPage(bytes, end === version.size);
  const next = offset + page.bytes;
  return {
    kind: "completed",
    output: {
      ...about,
      offset,
      content: page.text,
      ...(next < version.size ? { nextOffset: next } : {}),
    },
  };
}

/** Bytes `start` to `end` (both inclusive) of a version's blob. */
async function readRange(
  ctx: TenantContext,
  blobKey: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const got = await ctx.blobs.get(blobKey, { range: { start, end }, signal });
  if (!got) throw new Error("The artifact's bytes are missing from the Object store");
  return new Uint8Array(await new Response(got.body).arrayBuffer());
}

/**
 * The text of a page of UTF-8 `bytes` in whole characters, at most `READ_ARTIFACT_MAX_BYTES`
 * once escaped as JSON, and how many bytes it used: the next page starts there. A page that
 * starts inside a character skips its rest, and one that ends inside one (not `last`) stops
 * before it.
 */
function textPage(bytes: Uint8Array, last: boolean): { text: string; bytes: number } {
  const from = utf8Boundary(bytes, 0, "up");
  let to = last ? bytes.byteLength : utf8Boundary(bytes, bytes.byteLength, "down");
  // A page shorter than one character: take what there is.
  if (to <= from) to = bytes.byteLength;
  const decode = () => Buffer.from(bytes.subarray(from, to)).toString("utf8");
  let text = decode();
  // Escaped (quotes, newlines, control characters), text takes more room than its bytes: each
  // byte left out frees at least one.
  for (let size = jsonBytes(text); to > from && size > READ_ARTIFACT_MAX_BYTES; size = jsonBytes(text)) {
    to = utf8Boundary(bytes, Math.max(from, to - (size - READ_ARTIFACT_MAX_BYTES)), "down");
    text = decode();
  }
  return { text, bytes: to };
}
