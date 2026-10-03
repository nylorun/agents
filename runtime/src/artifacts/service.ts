/**
 * File artifacts (blueprint D35, F8.1): an opaque id, a name, numbered immutable versions,
 * metadata in Postgres and bytes in the Object store behind the `BlobStore` seam. Folders
 * (F8.2) are written by the turn-end export (`./export.ts`, `./folders.ts`) and read here.
 *
 * - **Uploads stream.** The body goes to the store as it arrives, at a fresh random key, counted
 *   against the per-file cap and what is left of the Tenant total (`maxBytes`): nothing is
 *   buffered whole, and a body past either limit stores nothing (`413 limit_exceeded`).
 * - **Postgres is the commit point.** One transaction writes the version row and, for a session's
 *   artifact, its `artifact.created` or `artifact.version.created` event through the record
 *   module, after re-checking the Tenant total under the quota lock. Until it commits the object
 *   is garbage, and a failed commit deletes it.
 * - **Access mirrors sessions.** An application principal reaches every artifact. A request acting
 *   for a person (a subject token or subject headers) reaches only artifacts of that person's
 *   sessions; another person's, or a Tenant-wide one, is the same 404 as a missing artifact.
 *
 * Lock order, the same in every write: the session, then the quota lock, then the artifact row.
 */
import { randomUUID } from "node:crypto";
import type {
  ArtifactSource,
  ArtifactVersionView,
  ArtifactView,
  FolderManifest,
} from "@nylorun/core/contracts";
import { ARTIFACT_NAME_MAX } from "@nylorun/core/contracts";
import { isArtifactId, newArtifactId } from "@nylorun/core/compatibility";
import { BlobTooLargeError, type BlobBody } from "../blob/index.js";
import type { ArtifactRow, ArtifactVersionRow, Tx } from "../store/types.js";
import {
  lockedSession,
  sessionOf,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "../tenant/context.js";
import { fail } from "../tenant/http.js";
import { readArtifactLimits, type ArtifactLimits } from "./config.js";
import { collectContent, readManifest } from "./folders.js";
import { contentTypeFor } from "./media-types.js";

/** What the caller may reach: undefined for the whole Tenant (an application principal). */
export type ArtifactAccess = SessionAccess | undefined;

export interface UploadInput {
  /** A new version of this artifact; otherwise a new artifact. */
  readonly artifactId?: string;
  /** The new artifact's name; for a new version, it stays the artifact's. */
  readonly name?: string;
  /** The declared media type; default: what the name's extension implies. */
  readonly contentType?: string;
  /** The session a new artifact belongs to. Required when acting for a person. */
  readonly sessionId?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** The body's declared length (`Content-Length`): one past the limits is refused unread. */
  readonly declaredBytes?: number;
  readonly source: ArtifactSource;
  /** The turn that saved it (`save_artifact`), for the event. */
  readonly turnId?: string | null;
  /** The tool call that saved it, for the event. */
  readonly callId?: string;
}

export interface Uploaded {
  readonly artifact: ArtifactView;
  readonly version: ArtifactVersionView;
}

const notFound = (): never => fail(404, "Artifact not found");

function tooLarge(message: string, limit: number): never {
  return fail(413, message, { code: "limit_exceeded", details: { limitBytes: limit } });
}

/** A body past `maxBytes`: past the per-file cap, or past what is left of the Tenant total. */
function tooLargeFor(maxBytes: number, limits: ArtifactLimits): never {
  return maxBytes === limits.fileBytes
    ? tooLarge(`A file may hold at most ${limits.fileBytes} bytes`, limits.fileBytes)
    : tooLarge(
        `The Tenant's artifacts may hold at most ${limits.totalBytes} bytes; this file does not fit`,
        limits.totalBytes,
      );
}

export function versionView(row: ArtifactVersionRow): ArtifactVersionView {
  return {
    version: row.version,
    size: row.size,
    sha256: row.sha256,
    contentType: row.contentType,
    source: row.source,
    createdAt: row.createdAt,
  };
}

export function artifactView(row: ArtifactRow, versions?: ArtifactVersionRow[]): ArtifactView {
  return {
    artifactId: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.contentType,
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    latestVersion: row.latestVersion,
    ...(row.labelsJson === null ? {} : { labels: JSON.parse(row.labelsJson) as Record<string, string> }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(versions === undefined ? {} : { versions: versions.map(versionView) }),
  };
}

/** An artifact name: 1–255 characters, no path separators or control characters. */
export function checkArtifactName(name: string | undefined): string {
  if (
    name === undefined ||
    name.trim() === "" ||
    name.length > ARTIFACT_NAME_MAX ||
    /[/\\\u0000-\u001f\u007f]/u.test(name) ||
    name === "." ||
    name === ".."
  )
    return fail(
      400,
      `An artifact name is 1 to ${ARTIFACT_NAME_MAX} characters, without '/', '\\' or control characters`,
    );
  return name;
}

/**
 * The artifact if the caller may reach it, else the 404 of a missing one. Reads its session
 * (without locking) to check whose it is.
 */
export async function readableArtifact(
  t: Tx,
  id: string,
  access: ArtifactAccess,
  options: { lock?: boolean } = {},
): Promise<ArtifactRow> {
  if (!isArtifactId(id)) return notFound();
  const row = await t.artifact(id, options);
  if (!row) return notFound();
  await checkReach(t, row, access);
  return row;
}

async function checkReach(t: Tx, row: ArtifactRow, access: ArtifactAccess): Promise<void> {
  if (access === undefined) return;
  if (row.sessionId === null) notFound();
  try {
    await sessionOf(t, row.sessionId!, access);
  } catch {
    notFound();
  }
}

/** `version`, or the latest when it is undefined; a missing one is a 404. */
export async function versionOf(
  t: Tx,
  row: ArtifactRow,
  version: number | undefined,
): Promise<ArtifactVersionRow> {
  const found = await t.artifactVersion(row.id, version ?? row.latestVersion);
  return found ?? fail(404, "Artifact version not found");
}

/**
 * Stores `body` as a new artifact, or a new version of one, within the Tenant's limits. See the
 * module comment for how it streams and commits.
 */
export async function uploadArtifact(
  ctx: TenantContext,
  input: UploadInput,
  body: BlobBody,
  access: ArtifactAccess,
  signal?: AbortSignal,
): Promise<Uploaded> {
  const name = input.artifactId === undefined ? checkArtifactName(input.name) : undefined;
  // Where it goes and how much room is left, before a byte is stored.
  const { limits, used, sessionId, fileName } = await ctx.store.tx(async (t) => {
    let sessionId: string | null;
    let fileName = name;
    if (input.artifactId !== undefined) {
      const prior = await readableArtifact(t, input.artifactId, access);
      if (prior.kind !== "file")
        fail(400, `Artifact ${prior.id} is a folder; its versions come from turn-end exports`);
      sessionId = prior.sessionId;
      fileName = prior.name;
    } else {
      if (input.sessionId === undefined && access !== undefined)
        fail(400, "Acting for a person, an artifact belongs to one of their sessions: name sessionId");
      if (input.sessionId !== undefined) await sessionOf(t, input.sessionId, access);
      sessionId = input.sessionId ?? null;
    }
    return { limits: await readArtifactLimits(t), used: await t.artifactBytes(), sessionId, fileName };
  });
  const contentType = input.contentType ?? contentTypeFor(fileName!);
  const room = limits.totalBytes - used;
  if (room <= 0)
    tooLarge(`The Tenant's artifacts hold ${used} of ${limits.totalBytes} bytes; delete some first`, limits.totalBytes);
  const maxBytes = Math.min(limits.fileBytes, room);
  if (input.declaredBytes !== undefined && input.declaredBytes > maxBytes)
    tooLargeFor(maxBytes, limits);
  const artifactId = input.artifactId ?? newArtifactId();
  const key = `artifacts/${artifactId}/${randomUUID()}`;
  let stored;
  try {
    stored = await ctx.blobs.put(key, body, {
      contentType,
      maxBytes,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof BlobTooLargeError) tooLargeFor(maxBytes, limits);
    throw error;
  }
  const createdAt = new Date().toISOString();
  try {
    return await ctx.store.tx(async (t) => {
      // The session first, then the quota, then the artifact (the module's lock order).
      let session: Session | undefined;
      if (sessionId !== null) session = await lockedSession(t, sessionId, access);
      await t.lockArtifactQuota();
      const total = await t.artifactBytes();
      if (total + stored.size > limits.totalBytes)
        tooLarge(
          `The Tenant's artifacts may hold at most ${limits.totalBytes} bytes; this file does not fit`,
          limits.totalBytes,
        );
      let row: ArtifactRow;
      let version: ArtifactVersionRow;
      if (input.artifactId !== undefined) {
        const prior = await readableArtifact(t, input.artifactId, access, { lock: true });
        version = {
          artifactId: prior.id,
          version: prior.latestVersion + 1,
          blobKey: key,
          size: stored.size,
          sha256: stored.sha256,
          contentType,
          source: input.source,
          createdAt,
        };
        await t.insertArtifactVersion(version);
        row = {
          ...prior,
          latestVersion: version.version,
          contentType: version.contentType,
          updatedAt: createdAt,
        };
      } else {
        row = {
          id: artifactId,
          kind: "file",
          name: name!,
          contentType,
          sessionId,
          latestVersion: 1,
          labelsJson:
            input.labels === undefined || Object.keys(input.labels).length === 0
              ? null
              : JSON.stringify(input.labels),
          createdAt,
          updatedAt: createdAt,
        };
        version = {
          artifactId,
          version: 1,
          blobKey: key,
          size: stored.size,
          sha256: stored.sha256,
          contentType,
          source: input.source,
          createdAt,
        };
        await t.insertArtifact(row, version);
      }
      if (session)
        await t.event(
          session.id,
          input.turnId ?? null,
          version.version === 1 ? "artifact.created" : "artifact.version.created",
          {
            artifactId: row.id,
            kind: "file",
            name: row.name,
            contentType: version.contentType,
            version: version.version,
            size: version.size,
            sha256: version.sha256,
            source: version.source,
            ...(input.callId === undefined ? {} : { callId: input.callId }),
          },
        );
      return { artifact: artifactView(row), version: versionView(version) };
    });
  } catch (error) {
    // Nothing references the object: it was garbage from the start.
    await ctx.blobs.delete(key).catch(() => undefined);
    throw error;
  }
}

/** The caller's artifacts: of one session, or of every session it reaches. */
export async function listArtifacts(
  ctx: TenantContext,
  filter: { sessionId?: string },
  access: ArtifactAccess,
): Promise<{ artifacts: ArtifactView[] }> {
  return ctx.store.tx(async (t) => {
    if (filter.sessionId !== undefined) {
      await sessionOf(t, filter.sessionId, access);
      return { artifacts: (await t.listArtifacts({ sessionId: filter.sessionId })).map((row) => artifactView(row)) };
    }
    const rows = await t.listArtifacts();
    if (access === undefined) return { artifacts: rows.map((row) => artifactView(row)) };
    const owned = new Map<string, boolean>();
    const reachable: ArtifactRow[] = [];
    for (const row of rows) {
      if (row.sessionId === null) continue;
      let ok = owned.get(row.sessionId);
      if (ok === undefined) {
        ok = await sessionOf(t, row.sessionId, access).then(
          () => true,
          () => false,
        );
        owned.set(row.sessionId, ok);
      }
      if (ok) reachable.push(row);
    }
    return { artifacts: reachable.map((row) => artifactView(row)) };
  });
}

/** One artifact with every version. */
export async function getArtifact(
  ctx: TenantContext,
  id: string,
  access: ArtifactAccess,
): Promise<ArtifactView> {
  return ctx.store.tx(async (t) => {
    const row = await readableArtifact(t, id, access);
    return artifactView(row, await t.artifactVersions(row.id));
  });
}

/** One version's row, for a download. */
export async function artifactContent(
  ctx: TenantContext,
  id: string,
  version: number | undefined,
  access: ArtifactAccess,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow }> {
  return ctx.store.tx(async (t) => {
    const artifact = await readableArtifact(t, id, access);
    return { artifact, version: await versionOf(t, artifact, version) };
  });
}

/** One version's row, its artifact and, for a folder, its manifest; a file is a 400. */
export async function folderContent(
  ctx: TenantContext,
  id: string,
  version: number | undefined,
  access: ArtifactAccess,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow; manifest: FolderManifest }> {
  const found = await artifactContent(ctx, id, version, access);
  if (found.artifact.kind !== "folder")
    fail(400, `Artifact ${found.artifact.id} is a file; download its content`);
  return { ...found, manifest: await readManifest(ctx.blobs, found.version) };
}

/**
 * Deletes the artifact and every version: its rows and, for a session's artifact, its
 * `artifact.deleted` event in one transaction, then its bytes. A folder's content-addressed
 * files go too, those no other version names, under the quota lock (`folders.ts`).
 */
export async function deleteArtifact(
  ctx: TenantContext,
  id: string,
  access: ArtifactAccess,
): Promise<{ artifactId: string; deleted: true }> {
  const keys = await ctx.store.tx(async (t) => {
    const found = await readableArtifact(t, id, access);
    if (found.sessionId !== null) await lockedSession(t, found.sessionId, access);
    if (found.kind === "folder") await t.lockArtifactQuota();
    const row = await readableArtifact(t, id, access, { lock: true });
    const content = row.kind === "folder" ? await t.artifactContentShas({ artifactId: row.id }) : [];
    const keys = await t.deleteArtifact(row.id);
    await collectContent(ctx.blobs, t, content);
    if (row.sessionId !== null)
      await t.event(row.sessionId, null, "artifact.deleted", { artifactId: row.id, name: row.name });
    return keys;
  });
  for (const key of keys) await ctx.blobs.delete(key).catch(() => undefined);
  return { artifactId: id, deleted: true };
}
