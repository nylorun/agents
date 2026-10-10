/**
 * Definition files (track R2 M4): the files a definition names by the SHA-256 of their bytes,
 * today a skill's folder (`SkillManifest.files`). A client uploads each one once
 * (`PUT /v1/files/sha256:<hex>`); its bytes go to the Object store at
 * `definitions/sha256/<hex>`, and a `definition_files` row says the Tenant holds it. A
 * definition naming a file the Tenant does not hold is refused (`definition_files_missing`).
 * The Runtime reads them to serve the skill tools and to give a sandbox the skills' files.
 *
 * Files are never deleted here: `definition_file_uses` records which definition version names
 * which file, for a later sweep.
 */
import { createHash } from "node:crypto";
import {
  DEFINITION_FILE_MAX_BYTES,
  definitionFilesOf,
  isDefinitionFileHash,
  type DefinitionFileView,
} from "@nylorun/core/contracts";
import type { BlobStore } from "../blob/index.js";
import type { Tx } from "../store/types.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";

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

/** The body, at most `DEFINITION_FILE_MAX_BYTES`; past it, `413 limit_exceeded`. */
async function readBody(body: ReadableStream<Uint8Array> | null, declared: number | undefined): Promise<Uint8Array> {
  const tooLarge = (): never =>
    fail(413, `A definition file may hold at most ${DEFINITION_FILE_MAX_BYTES} bytes`, {
      code: "limit_exceeded",
      details: { limitBytes: DEFINITION_FILE_MAX_BYTES },
    });
  if (declared !== undefined && declared > DEFINITION_FILE_MAX_BYTES) {
    await body?.cancel().catch(() => undefined);
    tooLarge();
  }
  if (body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DEFINITION_FILE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Stores the bytes of definition file `file`: `201` when they are new, `200` when the Tenant
 * holds them already (the body is not read). Bytes that do not hash to `file` are a `400`.
 */
export async function putDefinitionFile(
  ctx: TenantContext,
  file: string,
  request: { body: ReadableStream<Uint8Array> | null; declaredBytes?: number; contentType?: string },
  signal?: AbortSignal,
): Promise<{ status: 200 | 201; view: DefinitionFileView }> {
  const sha256 = checkHash(file);
  const held = await ctx.store.tx((t) => t.definitionFile(sha256));
  if (held) {
    await request.body?.cancel().catch(() => undefined);
    return { status: 200, view: { sha256, size: held.size } };
  }
  const bytes = await readBody(request.body, request.declaredBytes);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== sha256)
    fail(400, `The body's SHA-256 is ${actual}, not ${sha256}: upload a file at its own hash`, {
      code: "invalid_request",
      details: { expected: sha256, actual },
    });
  // The key is the content's hash: a concurrent upload of the same file writes the same bytes.
  await ctx.blobs.put(definitionFileKey(sha256), bytes, {
    ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    ...(signal ? { signal } : {}),
  });
  const inserted = await ctx.store.tx((t) =>
    t.insertDefinitionFile({
      sha256,
      kind: "skill",
      size: bytes.byteLength,
      contentType: request.contentType ?? null,
      createdAt: new Date().toISOString(),
    }),
  );
  return { status: inserted ? 201 : 200, view: { sha256, size: bytes.byteLength } };
}

/** The definition files `document` names that the Tenant does not hold, in order. */
export async function missingDefinitionFiles(t: Tx, document: unknown): Promise<string[]> {
  const named = [...definitionFilesOf(document)].sort();
  if (named.length === 0) return [];
  const held = await t.heldDefinitionFiles(named);
  return named.filter((sha256) => !held.has(sha256));
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
