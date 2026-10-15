/**
 * How model-gate reads the files a prompt names (protocol 6): a media part's reference is an
 * artifact version (`./parts.ts`), resolved here to its bytes from the Object store. The gate
 * holds the store credential; the loop and the transcript only ever hold the reference.
 *
 * It replaces `MediaStore`: images are file artifacts, and their bytes reach the provider only in
 * the request model-gate builds.
 */
import type { JsonValue } from "@nylorun/core/define";
import type { BlobStore } from "../blob/index.js";
import type { SessionStore } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { fileReferenceOf } from "./parts.js";

/** A file a prompt names, with its bytes. */
export interface ResolvedFile {
  readonly name: string;
  /** The version's media type, as stored. */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Why a file cannot go to the model: the message is the outcome's, so it names no secret. */
export class FileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileUnavailableError";
  }
}

/** Resolves a media part's reference to the file's bytes, or throws `FileUnavailableError`. */
export type FileResolver = (reference: JsonValue) => Promise<ResolvedFile>;

/**
 * Files from the Tenant's artifacts: `store` for the version's row, `blobs` for its bytes, for
 * the call of session `sessionId`. It reads what `read_artifact` reads: an artifact of the
 * session, or a Tenant-wide one its messages named (`Session.fileArtifacts`). Another session's
 * artifact, or a Tenant-wide one the session never named, is refused, and without a session
 * every file is: the check is never skipped. A file larger than the Tenant's Runtime limit
 * `modelFileBytes`, read with the row, is refused too.
 */
export function artifactFiles(options: {
  readonly store: SessionStore;
  readonly blobs: BlobStore;
  /** The session the call is for: the run token's, over HTTP. */
  readonly sessionId: string | undefined;
}): FileResolver {
  return async (value) => {
    const reference = fileReferenceOf(value);
    if (!reference) throw new FileUnavailableError("Expected an artifact reference.");
    const sessionId = options.sessionId;
    if (typeof sessionId !== "string" || sessionId === "")
      throw new FileUnavailableError("A model call reads files only for its own session.");
    const found = await options.store.tx(async (t) => {
      const artifact = await t.artifact(reference.artifactId);
      if (!artifact) return undefined;
      if (artifact.sessionId === null) {
        const session = await t.get<Pick<Session, "fileArtifacts">>("sessions", sessionId);
        if (!session?.fileArtifacts?.includes(artifact.id)) return undefined;
      } else if (artifact.sessionId !== sessionId) return undefined;
      const version = await t.artifactVersion(artifact.id, reference.version);
      return version ? { artifact, version, maxBytes: (await readRuntimeLimits(t)).modelFileBytes } : undefined;
    });
    if (!found)
      throw new FileUnavailableError(
        `Artifact ${reference.artifactId} version ${reference.version} is not available.`,
      );
    const { artifact, version, maxBytes } = found;
    if (artifact.kind !== "file")
      throw new FileUnavailableError(`${artifact.name} is a folder; a model reads files only.`);
    if (version.size > maxBytes)
      throw new FileUnavailableError(
        `${artifact.name} is ${version.size} bytes; a model reads files of at most ${maxBytes} bytes (the Runtime limit modelFileBytes).`,
      );
    const got = await options.blobs.get(version.blobKey);
    if (!got)
      throw new FileUnavailableError(`The bytes of ${artifact.name} are missing from the Object store.`);
    const bytes = new Uint8Array(await new Response(got.body).arrayBuffer());
    return { name: artifact.name, mediaType: version.contentType, bytes };
  };
}
