/**
 * Folder artifacts (blueprint D35, F8.2). A folder version is a **manifest**: JSON
 * `{ format, entries: [{ path, size, sha256, contentType }] }`, sorted by path, stored in the
 * Object store under the version's `blobKey` like a file's bytes. Each file's bytes are stored
 * once, content-addressed, at `blobs/sha256/<hex>`: a file that did not change between versions,
 * or that two folders share, is stored and counted once.
 *
 * Which content-addressed files are in use is indexed in Postgres (`artifact_content`, a row per
 * folder version and distinct hash), so deleting a folder removes only the files nothing else
 * names, and the Tenant total counts each file once.
 *
 * **Collecting content safely.** A writer skips the `put` of a file the store already has
 * (`head`), outside any lock, and a delete could remove that file before the writer commits. So:
 * content is deleted only while holding the quota lock, and every such delete moves the Tenant's
 * content epoch (setting `artifacts.content_epoch`) in the same transaction. A writer reads the
 * epoch before its first `head`; at commit, under the quota lock, a file some committed version
 * references is present (the invariant the lock keeps), and when the epoch moved it checks the
 * others again and refuses to commit a version naming a file that is gone.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactDiff, FolderEntry, FolderManifest } from "@nylorun/core/contracts";
import {
  FOLDER_CONTENT_TYPE,
  FOLDER_MANIFEST_FORMAT,
  FolderManifestSchema,
} from "@nylorun/core/contracts";
import type { BlobStore } from "../blob/index.js";
import type { ArtifactRow, ArtifactVersionRow, Tx } from "../store/types.js";
import { newArtifactId } from "@nylorun/core/compatibility";
import { lockedSession, type TenantContext } from "../tenant/context.js";
import { fail } from "../tenant/http.js";

const CONTENT_EPOCH_SETTING = "artifacts.content_epoch";

/** Where a folder file's bytes are: content-addressed by their SHA-256. */
export function contentKey(sha256: string): string {
  return `blobs/sha256/${sha256}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Entries in manifest order: by path, comparing UTF-16 code units. */
export function sortEntries(entries: readonly FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The manifest's bytes, as stored: deterministic for the same entries. */
export function encodeManifest(entries: readonly FolderEntry[]): Uint8Array {
  const manifest: FolderManifest = {
    format: FOLDER_MANIFEST_FORMAT,
    entries: sortEntries(entries).map(({ path, size, sha256, contentType }) => ({
      path,
      size,
      sha256,
      contentType,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** A folder version's manifest, read from the Object store. */
export async function readManifest(blobs: BlobStore, version: ArtifactVersionRow): Promise<FolderManifest> {
  const got = await blobs.get(version.blobKey);
  if (!got) return fail(404, "Artifact bytes not found");
  const parsed = FolderManifestSchema.safeParse(JSON.parse(await new Response(got.body).text()));
  if (!parsed.success) throw new Error(`The manifest of ${version.artifactId} v${version.version} is malformed`);
  return parsed.data;
}

/** The entry at `path`, or the 404 of a missing file. */
export function entryAt(manifest: FolderManifest, path: string): FolderEntry {
  return (
    manifest.entries.find((entry) => entry.path === path) ??
    fail(404, `No file ${path} in this folder version`)
  );
}

/** What changed from `from` (absent: nothing) to `to`. */
export function diffManifests(
  artifactId: string,
  from: { version: number; manifest: FolderManifest } | undefined,
  to: { version: number; manifest: FolderManifest },
): ArtifactDiff {
  const before = new Map((from?.manifest.entries ?? []).map((entry) => [entry.path, entry]));
  const after = new Map(to.manifest.entries.map((entry) => [entry.path, entry]));
  const added: FolderEntry[] = [];
  const changed: ArtifactDiff["changed"] = [];
  for (const entry of to.manifest.entries) {
    const prior = before.get(entry.path);
    if (!prior) added.push(entry);
    else if (prior.sha256 !== entry.sha256 || prior.contentType !== entry.contentType)
      changed.push({ path: entry.path, from: prior, to: entry });
  }
  const removed = (from?.manifest.entries ?? []).filter((entry) => !after.has(entry.path));
  return {
    artifactId,
    ...(from === undefined ? {} : { from: from.version }),
    to: to.version,
    added,
    removed,
    changed,
  };
}

/** The Tenant's content epoch: moves whenever content-addressed files are deleted. */
export async function contentEpoch(t: Tx): Promise<number> {
  const raw = await t.getSetting(CONTENT_EPOCH_SETTING);
  return raw === undefined ? 0 : Number(raw);
}

/**
 * Deletes those of `shas` no committed folder version references any more, and moves the content
 * epoch when it deletes any. Call it in a transaction holding the quota lock, after the rows that
 * named them are gone: the deletes happen before the transaction commits, under the lock.
 */
export async function collectContent(
  blobs: BlobStore,
  t: Tx,
  shas: readonly string[],
): Promise<number> {
  if (shas.length === 0) return 0;
  const referenced = await t.referencedArtifactContent(shas);
  const orphans = shas.filter((sha) => !referenced.has(sha));
  if (orphans.length === 0) return 0;
  await t.putSetting(CONTENT_EPOCH_SETTING, String((await contentEpoch(t)) + 1));
  for (const sha of orphans) await blobs.delete(contentKey(sha));
  return orphans.length;
}

/** The commit could not go ahead: a limit, or content removed while the export ran. */
export class FolderCommitRefused extends Error {
  constructor(
    message: string,
    readonly reason: "tenant_total" | "content_gone" | "artifact_gone",
    readonly limit?: number,
  ) {
    super(message);
    this.name = "FolderCommitRefused";
  }
}

export interface FolderVersionInput {
  readonly sessionId: string;
  readonly turnId: string | null;
  /** A new version of this folder of the session; otherwise a new folder named `name`. */
  readonly artifactId?: string;
  readonly name: string;
  /** Every file, each one's bytes already at `contentKey(sha256)`. */
  readonly entries: readonly FolderEntry[];
  /** The content epoch read before the first `head` of those bytes. */
  readonly epoch: number;
  /** The Tenant total in force. */
  readonly totalBytes: number;
}

/**
 * Commits a folder version whose files are already stored: its manifest to the Object store,
 * then, in one transaction under the session and quota locks, the version row, its content rows
 * and `artifact.created` or `artifact.version.created` (`claimed: true`, source `export`).
 * Throws `FolderCommitRefused` when the Tenant total would be passed or a file is gone.
 */
export async function commitFolderVersion(
  ctx: TenantContext,
  input: FolderVersionInput,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow }> {
  const entries = sortEntries(input.entries);
  const manifest = encodeManifest(entries);
  const sha256 = sha256Hex(manifest);
  const files = new Map<string, number>();
  for (const entry of entries) files.set(entry.sha256, entry.size);
  const size = entries.reduce((sum, entry) => sum + entry.size, 0);
  const artifactId = input.artifactId ?? newArtifactId();
  const key = `artifacts/${artifactId}/${randomUUID()}`;
  await ctx.blobs.put(key, manifest, { contentType: FOLDER_CONTENT_TYPE });
  const createdAt = new Date().toISOString();
  try {
    return await ctx.store.tx(async (t) => {
      // The session first, then the quota, then the artifact (the module's lock order).
      await lockedSession(t, input.sessionId);
      await t.lockArtifactQuota();
      const shas = [...files.keys()];
      const referenced = await t.referencedArtifactContent(shas);
      const fresh = shas.filter((sha) => !referenced.has(sha));
      if ((await contentEpoch(t)) !== input.epoch)
        for (const sha of fresh)
          if (!(await ctx.blobs.head(contentKey(sha))))
            throw new FolderCommitRefused(
              "A file's bytes were removed while the export ran",
              "content_gone",
            );
      const added = fresh.reduce((sum, sha) => sum + files.get(sha)!, 0);
      const total = await t.artifactBytes();
      if (total + added > input.totalBytes)
        throw new FolderCommitRefused(
          `The Tenant's artifacts may hold at most ${input.totalBytes} bytes; these outputs add ${added} to ${total}`,
          "tenant_total",
          input.totalBytes,
        );
      let row: ArtifactRow;
      const version: ArtifactVersionRow = {
        artifactId,
        version: 1,
        blobKey: key,
        size,
        sha256,
        contentType: FOLDER_CONTENT_TYPE,
        source: "export",
        createdAt,
      };
      if (input.artifactId !== undefined) {
        const prior = await t.artifact(input.artifactId, { lock: true });
        if (!prior || prior.kind !== "folder" || prior.sessionId !== input.sessionId)
          throw new FolderCommitRefused("The folder was deleted while the export ran", "artifact_gone");
        version.version = prior.latestVersion + 1;
        await t.insertArtifactVersion(version);
        row = { ...prior, latestVersion: version.version, contentType: FOLDER_CONTENT_TYPE, updatedAt: createdAt };
      } else {
        row = {
          id: artifactId,
          kind: "folder",
          name: input.name,
          contentType: FOLDER_CONTENT_TYPE,
          sessionId: input.sessionId,
          latestVersion: 1,
          labelsJson: null,
          createdAt,
          updatedAt: createdAt,
        };
        await t.insertArtifact(row, version);
      }
      await t.insertArtifactContent(
        artifactId,
        version.version,
        shas.map((sha) => ({ sha256: sha, size: files.get(sha)! })),
      );
      await t.event(
        input.sessionId,
        input.turnId,
        version.version === 1 ? "artifact.created" : "artifact.version.created",
        {
          artifactId,
          kind: "folder",
          name: row.name,
          contentType: FOLDER_CONTENT_TYPE,
          version: version.version,
          size,
          sha256,
          source: "export",
          fileCount: entries.length,
          claimed: true,
        },
      );
      return { artifact: row, version };
    });
  } catch (error) {
    // Nothing references the manifest: it was garbage from the start.
    await ctx.blobs.delete(key).catch(() => undefined);
    throw error;
  }
}
