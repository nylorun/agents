/**
 * Definition files (track R2 M4): the files a definition names by the SHA-256 of their bytes,
 * today a skill's folder (`SkillManifest.files`). A client uploads each one once
 * (`PUT /v1/files/sha256:<hex>`); its bytes go to the Object store at
 * `definitions/sha256/<hex>`, and a `definition_files` row says the Tenant holds it. A
 * definition naming a file the Tenant does not hold is refused (`definition_files_missing`), and
 * one whose skill's files hold more than the Tenant's skill limit together (`limit_exceeded`,
 * `skills.config`, default 2 GiB). One file may be as large as a whole skill.
 * The Runtime serves them to a run's harness (`definition.file`: our engine's skill tools read
 * them) and gives a sandbox the skills' files.
 *
 * Files are never deleted here: `definition_file_uses` records which definition version names
 * which file, for a later sweep.
 */
import { randomUUID } from "node:crypto";
import {
  definitionFilesOf,
  isDefinitionFileHash,
  skillsOf,
  type DefinitionFileView,
} from "@nylorun/core/contracts";
import { BlobTooLargeError, type BlobPutResult, type BlobStore } from "../blob/index.js";
import type { Tx } from "../store/types.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";
import { readSkillLimits } from "./limits.js";

/** Where an upload's bytes wait while their hash is checked; never read as a definition file. */
const STAGING_PREFIX = "definitions/uploads/";

/** Where a definition file's bytes are in the Object store. */
export function definitionFileKey(sha256: string): string {
  return `definitions/sha256/${sha256.slice("sha256:".length)}`;
}

function checkHash(file: string): string {
  if (!isDefinitionFileHash(file))
    fail(400, "A definition file is named sha256:<64 lowercase hex>", { code: "invalid_request" });
  return file;
}

/** Whether the Tenant holds definition file `file` (`sha256:<hex>`). */
export async function hasDefinitionFile(ctx: TenantContext, file: string): Promise<boolean> {
  const sha256 = checkHash(file);
  return (await ctx.store.tx((t) => t.definitionFile(sha256))) !== undefined;
}

function tooLarge(limitBytes: number): never {
  return fail(413, `A definition file may hold at most ${limitBytes} bytes, the Tenant's limit for a whole skill`, {
    code: "limit_exceeded",
    details: { limitBytes },
  });
}

/**
 * Stores the bytes of definition file `file`: `201` when they are new, `200` when the Tenant
 * holds them already (the body is not read). Bytes that do not hash to `file` are a `400`; more
 * than the Tenant's skill limit (`skills.config`) a `413`. The body streams to a staging key and is copied to
 * the file's key only once its hash is checked, so no file is held in memory and bytes of
 * another hash never replace a file at its key.
 */
export async function putDefinitionFile(
  ctx: TenantContext,
  file: string,
  request: { body: ReadableStream<Uint8Array> | null; declaredBytes?: number; contentType?: string },
  signal?: AbortSignal,
): Promise<{ status: 200 | 201; view: DefinitionFileView }> {
  const sha256 = checkHash(file);
  const { held, maxBytes } = await ctx.store.tx(async (t) => ({
    held: await t.definitionFile(sha256),
    maxBytes: (await readSkillLimits(t)).totalBytes,
  }));
  if (held) {
    await request.body?.cancel().catch(() => undefined);
    return { status: 200, view: { sha256, size: held.size } };
  }
  if (request.declaredBytes !== undefined && request.declaredBytes > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    tooLarge(maxBytes);
  }
  const options = {
    ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    ...(signal ? { signal } : {}),
  };
  const staging = `${STAGING_PREFIX}${randomUUID()}`;
  let size: number;
  try {
    let staged: BlobPutResult;
    try {
      staged = await ctx.blobs.put(staging, request.body ?? new Uint8Array(), {
        ...options,
        maxBytes,
      });
    } catch (error) {
      if (error instanceof BlobTooLargeError) tooLarge(maxBytes);
      throw error;
    }
    const actual = `sha256:${staged.sha256}`;
    if (actual !== sha256)
      fail(400, `The body's SHA-256 is ${actual}, not ${sha256}: upload a file at its own hash`, {
        code: "invalid_request",
        details: { expected: sha256, actual },
      });
    const got = await ctx.blobs.get(staging, signal ? { signal } : {});
    if (!got) throw new Error(`The Object store lost the upload of ${sha256} at ${staging}`);
    // The key is the content's hash: a concurrent upload of the same file writes the same bytes.
    await ctx.blobs.put(definitionFileKey(sha256), got.body, options);
    size = staged.size;
  } finally {
    await ctx.blobs.delete(staging).catch(() => undefined);
  }
  const inserted = await ctx.store.tx((t) =>
    t.insertDefinitionFile({
      sha256,
      kind: "skill",
      size,
      contentType: request.contentType ?? null,
      createdAt: new Date().toISOString(),
    }),
  );
  return { status: inserted ? 201 : 200, view: { sha256, size } };
}

/**
 * Why `document` cannot be stored for the files it names: the files the Tenant does not hold
 * (`missing`), else each skill whose files hold more than `limitBytes` together (`oversized`).
 * A file a skill names at two paths counts twice: a sandbox holds both.
 */
export async function definitionFileIssues(
  t: Tx,
  document: unknown,
  limitBytes: number,
): Promise<{ missing: string[]; oversized: { name: string; bytes: number }[] }> {
  const named = [...definitionFilesOf(document)].sort();
  if (named.length === 0) return { missing: [], oversized: [] };
  const held = await t.heldDefinitionFiles(named);
  const missing = named.filter((sha256) => !held.has(sha256));
  if (missing.length > 0) return { missing, oversized: [] };
  const oversized: { name: string; bytes: number }[] = [];
  for (const skill of skillsOf(document)) {
    let bytes = 0;
    for (const hash of Object.values(skill.files ?? {}))
      if (typeof hash === "string") bytes += held.get(hash) ?? 0;
    if (bytes > limitBytes) oversized.push({ name: String(skill.name), bytes });
  }
  return { missing, oversized };
}

/** A definition file's bytes as a stream, or undefined when the Object store does not have them. */
export async function openDefinitionFile(
  blobs: BlobStore,
  sha256: string,
  options: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
): Promise<ReadableStream<Uint8Array> | undefined> {
  return (await blobs.get(definitionFileKey(sha256), options))?.body;
}

/** A definition file's bytes, or undefined when the Object store does not have them. */
export async function readDefinitionFile(
  blobs: BlobStore,
  sha256: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const got = await blobs.get(definitionFileKey(sha256), signal ? { signal } : {});
  if (!got) return undefined;
  return new Uint8Array(await new Response(got.body).arrayBuffer());
}
