/**
 * `nylorun.save_artifact` (F8.1): our engine's built-in tool that saves a file as an artifact
 * of its session. The `nylorun.artifacts` capability comes with a session's sandbox
 * (`sandbox/session-sandbox.ts`); the Runtime runs the tool itself, like the sandbox tools:
 *
 * - `path`: a file in the session's sandbox, read as bytes in the sandbox's queue;
 * - `content`: text the model passes.
 *
 * The version commits with `artifact.created` (or `artifact.version.created`) on the session's
 * stream, carrying the turn and the tool call. Expected problems (no such file, too large, the
 * Tenant's total reached) are failed outcomes the model sees; only infrastructure errors throw.
 */
import { basename } from "node:path";
import type { SandboxToolOutcome } from "@nylorun/core/contracts";
import {
  ARTIFACTS_CAPABILITY_ID,
  SANDBOX_CAPABILITY_ID,
  SAVE_ARTIFACT_TOOL,
  type AgentManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { isArtifactId } from "@nylorun/core/compatibility";
import { readArtifactLimits } from "../artifacts/config.js";
import { contentTypeFor, normalizeContentType } from "../artifacts/media-types.js";
import { uploadArtifact } from "../artifacts/service.js";
import { DEFAULT_CONTENT_TYPE } from "../blob/index.js";
import { sandboxCapabilityOf } from "../sandbox/manager.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { sandboxLookup, sessionOf, type TenantContext } from "./context.js";
import { HttpError } from "./http.js";
import { manifestFor } from "./session.js";
import { toolIds } from "./transcript.js";

/** True when `request` calls `save_artifact` of the `nylorun.artifacts` capability `manifest` has. */
export function isSaveArtifactCall(manifest: AgentManifest | undefined, request: HostEffect): boolean {
  return (
    request.kind === "tool" &&
    request.capabilityId === ARTIFACTS_CAPABILITY_ID &&
    request.toolName === SAVE_ARTIFACT_TOOL &&
    manifest?.capabilities.some((capability) => capability.id === ARTIFACTS_CAPABILITY_ID) === true
  );
}

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
    const lookup = await sandboxLookup(t, s.id);
    // A new version only of an artifact of this session.
    const ours =
      artifactId === undefined ||
      (isArtifactId(artifactId) && (await t.artifact(artifactId))?.sessionId === s.id);
    return {
      s,
      workspace: sandboxWorkspaceOf(s, lookup),
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
        ...(workspace.sandboxId === undefined ? {} : { sandboxId: workspace.sandboxId }),
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
