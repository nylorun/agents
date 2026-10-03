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
import { MODEL_FILE_MAX_BYTES } from "./media-types.js";
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
 * the call of session `sessionId`. An artifact of another session is refused (a Tenant-wide one
 * is not), and without a session every file is: the check is never skipped.
 */
export function artifactFiles(options: {
  readonly store: SessionStore;
  readonly blobs: BlobStore;
  /** The session the call is for: the run token's, over HTTP. */
  readonly sessionId: string | undefined;
  readonly maxBytes?: number;
}): FileResolver {
  const maxBytes = options.maxBytes ?? MODEL_FILE_MAX_BYTES;
  return async (value) => {
    const reference = fileReferenceOf(value);
    if (!reference) throw new FileUnavailableError("Expected an artifact reference.");
    const sessionId = options.sessionId;
    if (typeof sessionId !== "string" || sessionId === "")
      throw new FileUnavailableError("A model call reads files only for its own session.");
    const found = await options.store.tx(async (t) => {
      const artifact = await t.artifact(reference.artifactId);
      if (!artifact) return undefined;
      const version = await t.artifactVersion(artifact.id, reference.version);
      return version ? { artifact, version } : undefined;
    });
    if (
      !found ||
      (found.artifact.sessionId !== null && found.artifact.sessionId !== sessionId)
    )
      throw new FileUnavailableError(
        `Artifact ${reference.artifactId} version ${reference.version} is not available.`,
      );
    const { artifact, version } = found;
    if (version.size > maxBytes)
      throw new FileUnavailableError(
        `${artifact.name} is ${version.size} bytes; a model reads files of at most ${maxBytes} bytes.`,
      );
    const got = await options.blobs.get(version.blobKey);
    if (!got)
      throw new FileUnavailableError(`The bytes of ${artifact.name} are missing from the Object store.`);
    const bytes = new Uint8Array(await new Response(got.body).arrayBuffer());
    return { name: artifact.name, mediaType: version.contentType, bytes };
  };
}
