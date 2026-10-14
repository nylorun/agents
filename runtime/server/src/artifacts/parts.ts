/**
 * Message `parts` (protocol 6): what a user message's text and file parts become for the
 * engine. A file part names an artifact the caller may read, of this session or Tenant-wide;
 * its version is pinned when the message is accepted (the latest when the part names none).
 * The engine gets an opaque media part whose `reference` is `{ artifactId, version }`: model-gate
 * resolves it to bytes (`./files.ts`), and the transcript and the record never hold them.
 */
import type { MessagePart, ModelInput } from "@nylorun/core/contracts";
import type { JsonObject, JsonValue } from "@nylorun/core/define";
import type { Tx } from "../store/types.js";
import { fail } from "../tenant/http.js";
import { unreadableReason } from "./media-types.js";
import { readableArtifact, versionOf, type ArtifactAccess } from "./service.js";

/** A user-message content part, as the engine's `MessageInput.content` takes it. */
export type EnginePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "media"; readonly mediaType: string; readonly reference: JsonObject };

/** The reference a media part carries: the artifact version, by id. */
export interface FileReference {
  readonly artifactId: string;
  readonly version: number;
}

export function fileReferenceOf(value: JsonValue | undefined): FileReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { artifactId, version } = value as Record<string, unknown>;
  if (typeof artifactId !== "string" || typeof version !== "number" || !Number.isInteger(version))
    return undefined;
  return { artifactId, version };
}

/** A file part the Tenant's model does not read (protocol 12, `attachment_unsupported`). */
export interface RefusedPart {
  readonly artifactId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly reason: string;
}

/**
 * The parts with each file pinned to a version: for the engine (`engine`) and for a workflow's
 * JSON input (`pinned`). Reads in the caller's transaction. With `inputs`, what the Tenant's model
 * reads, each file of a type it does not read is in `refused` (its type only: no size is checked).
 */
export async function resolveMessageParts(
  t: Tx,
  parts: readonly MessagePart[],
  sessionId: string,
  access: ArtifactAccess,
  inputs?: readonly ModelInput[],
): Promise<{ engine: EnginePart[]; pinned: MessagePart[]; refused: RefusedPart[] }> {
  const engine: EnginePart[] = [];
  const pinned: MessagePart[] = [];
  const refused: RefusedPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      engine.push({ type: "text", text: part.text });
      pinned.push(part);
      continue;
    }
    const artifact = await readableArtifact(t, part.artifactId, access);
    if (artifact.sessionId !== null && artifact.sessionId !== sessionId)
      fail(400, `Artifact ${artifact.id} belongs to another session`);
    if (artifact.kind !== "file")
      fail(400, `Artifact ${artifact.id} is a folder; a file part names a file artifact`);
    const version = await versionOf(t, artifact, part.version);
    const reason = inputs && unreadableReason(version.contentType, inputs);
    if (reason)
      refused.push({ artifactId: artifact.id, name: artifact.name, mediaType: version.contentType, reason });
    engine.push({
      type: "media",
      mediaType: version.contentType,
      reference: {
        artifactId: artifact.id,
        version: version.version,
        name: artifact.name,
        size: version.size,
      },
    });
    pinned.push({ type: "file", artifactId: artifact.id, version: version.version });
  }
  return { engine, pinned, refused };
}
