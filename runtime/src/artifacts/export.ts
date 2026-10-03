/**
 * The turn-end export (F8.2): when an agent's turn completes, core reads `/workspace/outputs` of
 * the session's sandbox through the `WorkspaceReader` seam and keeps it as a version of the
 * session's folder artifact `outputs` (the first export creates it; later turns add versions,
 * and a turn whose outputs did not change adds none).
 *
 * - **After the turn.** The advance calls `exportOutputs` once `settle` has committed the turn,
 *   outside its transaction and while it still holds the session's lease, so the next turn
 *   cannot change the workspace under it. Nothing here fails the turn: a sandbox or store
 *   failure is logged and recorded as `artifact.export.failed`.
 * - **Claimed.** The listing and the bytes are what the holder of the workspace supplied: the
 *   version's source is `export` and its event says `claimed: true`.
 * - **Bounded.** At most `EXPORT_MAX_FILES` files and `EXPORT_MAX_BYTES` bytes per export, each
 *   file within the Tenant's per-file limit, and the new bytes within its total; past any of
 *   them nothing is stored and `artifact.export.skipped` says why.
 * - **Deduplicated.** Each file is stored content-addressed (`folders.ts`); a file the store
 *   already holds is not stored again.
 *
 * No sandbox, a sandbox never created, or an empty or missing `/workspace/outputs` exports
 * nothing and records nothing. The package's declared outputs are left for later: the manifest
 * has no `outputs` field yet.
 */
import { posix } from "node:path";
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_FILES,
  OUTPUTS_ARTIFACT_NAME,
  type ArtifactExportSkipReason,
  type FolderEntry,
} from "@nylorun/core/contracts";
import { SANDBOX_WORKSPACE, type AgentManifest } from "@nylorun/core/define";
import { isWorkflowManifest } from "../core/flow-host.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { SandboxFileTooLargeError } from "../sandbox/types.js";
import { sandboxLookup, type Session, type TenantContext } from "../tenant/context.js";
import { readArtifactLimits } from "./config.js";
import {
  collectContent,
  commitFolderVersion,
  contentEpoch,
  contentKey,
  encodeManifest,
  FolderCommitRefused,
  sha256Hex,
} from "./folders.js";
import { contentTypeFor } from "./media-types.js";
import type { WorkspaceSession } from "./workspace.js";

/** The directory every sandbox's outputs are exported from. */
export const OUTPUTS_DIR = `${SANDBOX_WORKSPACE}/outputs`;

/** Stops the export with `artifact.export.skipped`. */
class Skip extends Error {
  constructor(
    readonly reason: ArtifactExportSkipReason,
    message: string,
    readonly limit?: number,
    readonly path?: string,
  ) {
    super(message);
  }
}

/**
 * Exports the outputs of turn `turnId` of session `sessionId`, if it completed and its sandbox
 * has any. Never throws.
 */
export async function exportOutputs(
  ctx: TenantContext,
  sessionId: string,
  turnId: string | null,
  signal: AbortSignal,
): Promise<void> {
  try {
    await runExport(ctx, sessionId, turnId, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted) {
      ctx.config.logger.info("outputs export stopped", { sessionId, message });
      return;
    }
    const skip =
      error instanceof Skip
        ? error
        : error instanceof FolderCommitRefused && error.reason === "tenant_total"
          ? new Skip("tenant_total", error.message, error.limit)
          : undefined;
    if (!skip) ctx.config.logger.warn("outputs export failed", { sessionId, message });
    try {
      await ctx.store.tx(async (t) => {
        if (skip)
          await t.event(sessionId, turnId, "artifact.export.skipped", {
            name: OUTPUTS_ARTIFACT_NAME,
            reason: skip.reason,
            message: skip.message,
            ...(skip.limit === undefined ? {} : { limit: skip.limit }),
            ...(skip.path === undefined ? {} : { path: skip.path }),
          });
        else
          await t.event(sessionId, turnId, "artifact.export.failed", {
            name: OUTPUTS_ARTIFACT_NAME,
            message,
          });
      });
    } catch {
      /* the session is gone (reset) or the store closed */
    }
  }
}

async function runExport(
  ctx: TenantContext,
  sessionId: string,
  turnId: string | null,
  signal: AbortSignal,
): Promise<void> {
  const found = await ctx.store.tx(async (t) => {
    const s = await t.get<Session>("sessions", sessionId);
    // Only a turn that completed, and only an agent's (a flow agent's sandbox is its agents').
    if (!s || s.status !== "completed" || s.lastTurnId !== turnId || isWorkflowManifest(s.manifest))
      return undefined;
    const workspace = sandboxWorkspaceOf(s, await sandboxLookup(t, s.id));
    const prior = (await t.listArtifacts({ sessionId })).find(
      (row) => row.kind === "folder" && row.name === OUTPUTS_ARTIFACT_NAME,
    );
    const latest = prior ? await t.artifactVersion(prior.id, prior.latestVersion) : undefined;
    return {
      session: {
        sessionId,
        turnId,
        ownerId: workspace.ownerId,
        ...(workspace.sandboxId === undefined ? {} : { sandboxId: workspace.sandboxId }),
        manifest: s.manifest as AgentManifest,
      } satisfies WorkspaceSession,
      limits: await readArtifactLimits(t),
      priorId: prior?.id,
      latestSha: latest?.sha256,
      epoch: await contentEpoch(t),
    };
  });
  if (!found) return;
  const { session, limits } = found;
  const listing = await ctx.workspaces.list(session, OUTPUTS_DIR, {
    maxEntries: EXPORT_MAX_FILES,
    signal,
  });
  if (!listing || listing.entries.length === 0) return;
  if (listing.truncated)
    throw new Skip(
      "too_many_files",
      `${OUTPUTS_DIR} holds more than ${EXPORT_MAX_FILES} files`,
      EXPORT_MAX_FILES,
    );
  const large = listing.entries.find((entry) => entry.size > limits.fileBytes);
  if (large) throw tooLargeFile(large.path, large.size, limits.fileBytes);
  const maxBytes = Math.min(EXPORT_MAX_BYTES, limits.totalBytes);
  const listed = listing.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (listed > maxBytes) throw tooLarge(listed, maxBytes);

  // The files this export stored: removed again if it commits nothing, unless another version
  // names them by then.
  const put: string[] = [];
  try {
    await storeAndCommit(ctx, found, listing.entries, maxBytes, put, signal);
  } catch (error) {
    if (put.length > 0)
      await ctx.store
        .tx(async (t) => {
          await t.lockArtifactQuota();
          await collectContent(ctx.blobs, t, put);
        })
        .catch(() => undefined);
    throw error;
  }
}

async function storeAndCommit(
  ctx: TenantContext,
  found: {
    session: WorkspaceSession;
    limits: { fileBytes: number; totalBytes: number };
    priorId: string | undefined;
    latestSha: string | undefined;
    epoch: number;
  },
  listed: readonly { path: string; size: number }[],
  maxBytes: number,
  put: string[],
  signal: AbortSignal,
): Promise<void> {
  const { session, limits } = found;
  const { sessionId, turnId } = session;
  const entries: FolderEntry[] = [];
  const stored = new Set<string>();
  let read = 0;
  for (const entry of listed) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await ctx.workspaces.readBytes(session, posix.join(OUTPUTS_DIR, entry.path), {
        maxBytes: limits.fileBytes,
        signal,
      });
    } catch (error) {
      if (error instanceof SandboxFileTooLargeError)
        throw tooLargeFile(entry.path, error.size, limits.fileBytes);
      throw error;
    }
    // Gone since the listing: the folder is what is there now.
    if (bytes === undefined) continue;
    read += bytes.length;
    if (read > maxBytes) throw tooLarge(read, maxBytes);
    const sha256 = sha256Hex(bytes);
    const contentType = contentTypeFor(posix.basename(entry.path));
    if (!stored.has(sha256)) {
      stored.add(sha256);
      const key = contentKey(sha256);
      if (!(await ctx.blobs.head(key))) {
        put.push(sha256);
        await ctx.blobs.put(key, bytes, { contentType, signal });
      }
    }
    entries.push({ path: entry.path, size: bytes.length, sha256, contentType });
  }
  // Every file vanished, or nothing changed since the last export: no new version.
  if (entries.length === 0) return;
  if (found.latestSha !== undefined && sha256Hex(encodeManifest(entries)) === found.latestSha) return;
  await commitFolderVersion(ctx, {
    sessionId,
    turnId,
    ...(found.priorId === undefined ? {} : { artifactId: found.priorId }),
    name: OUTPUTS_ARTIFACT_NAME,
    entries,
    epoch: found.epoch,
    totalBytes: limits.totalBytes,
  });
}

function tooLargeFile(path: string, size: number, limit: number): Skip {
  return new Skip(
    "file_too_large",
    `${OUTPUTS_DIR}/${path} is ${size} bytes; a file may hold at most ${limit}`,
    limit,
    path,
  );
}

function tooLarge(bytes: number, limit: number): Skip {
  return new Skip(
    "too_large",
    `${OUTPUTS_DIR} holds ${bytes} bytes; an export stores at most ${limit}`,
    limit,
  );
}
