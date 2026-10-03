/**
 * The `WorkspaceReader` seam (F8.2): how core reads a session's sandbox workspace at turn end, to
 * export its outputs as a folder artifact. Two calls, a listing and one file's bytes, both the
 * claim of whoever holds the workspace: the Runtime stores what it is given without observing it.
 *
 * One implementation, `sandboxWorkspaceReader`, over the workspace capability (F6.2,
 * `harness-api/workspace.ts`): the in-process `SandboxManager`, or the harness that serves the
 * Tenant's workspaces (`workspace.read`). F6.2 reimplements it over the Harness API's `workspace.read`, and F7.2's pod
 * sandboxes are read through the same seam, so the export never knows which kind of sandbox it
 * reads.
 */
import {
  SANDBOX_CAPABILITY_ID,
  type AgentManifest,
} from "@nylorun/core/define";
import { sandboxCapabilityOf, type SandboxManager } from "../sandbox/manager.js";

/** What the reader needs of a workspace: a `SandboxManager`, or the workspace capability. */
export type WorkspaceFiles = Pick<SandboxManager, "listFiles" | "readBytes">;
import { SandboxFileTooLargeError } from "../sandbox/types.js";

/** Whose workspace to read: the session whose turn ended, resolved to the workspace it uses. */
export interface WorkspaceSession {
  /** The session whose turn ended. */
  readonly sessionId: string;
  /** The turn that ended. */
  readonly turnId: string | null;
  /** The session that owns the workspace (one hop through `sandboxOwnerId`). */
  readonly ownerId: string;
  /** The sandbox resource the workspace belongs to, when the owner is attached to one. */
  readonly sandboxId?: string;
  /** The session's pinned manifest: its sandbox capability carries the sandbox's spec. */
  readonly manifest: AgentManifest;
}

/** One regular file under the listed directory. */
export interface WorkspaceEntry {
  /** Relative to the directory listed, `/`-separated, never `.` or `..` segments. */
  readonly path: string;
  readonly size: number;
}

export interface WorkspaceListing {
  /** The files in path order, symbolic links left out. */
  readonly entries: readonly WorkspaceEntry[];
  /** More than `maxEntries` files: `entries` holds `maxEntries + 1` of them. */
  readonly truncated: boolean;
}

export interface WorkspaceReader {
  /**
   * The regular files under `dir` (absolute, e.g. `/workspace/outputs`), recursively. Undefined
   * when the session has no sandbox, its sandbox was never created, or `dir` is not a directory.
   */
  list(
    session: WorkspaceSession,
    dir: string,
    options: { readonly maxEntries: number; readonly signal: AbortSignal },
  ): Promise<WorkspaceListing | undefined>;
  /**
   * One file's bytes (absolute path), or undefined when it is gone. A file larger than
   * `maxBytes` throws `SandboxFileTooLargeError`; a sandbox that fails throws.
   */
  readBytes(
    session: WorkspaceSession,
    path: string,
    options: { readonly maxBytes: number; readonly signal: AbortSignal },
  ): Promise<Uint8Array | undefined>;
}

/** The reader over the workspaces, in each sandbox's queue of tool calls. */
export function sandboxWorkspaceReader(sandbox: WorkspaceFiles): WorkspaceReader {
  const target = (session: WorkspaceSession) => {
    const capability = sandboxCapabilityOf(session.manifest, SANDBOX_CAPABILITY_ID, "read");
    if (!capability) return undefined;
    return {
      capability,
      ref: {
        id: session.ownerId,
        activeTurnId: session.turnId,
        manifest: session.manifest,
        ...(session.sandboxId === undefined ? {} : { sandboxId: session.sandboxId }),
      },
    };
  };
  return {
    async list(session, dir, options) {
      const found = target(session);
      if (!found) return undefined;
      const listed = await sandbox.listFiles(
        found.ref,
        found.capability,
        dir,
        options.maxEntries,
        options.signal,
      );
      if (listed.kind === "missing") return undefined;
      if (listed.kind === "failed") throw new Error(listed.message);
      return listed.listing;
    },
    async readBytes(session, path, options) {
      const found = target(session);
      if (!found) return undefined;
      const read = await sandbox.readBytes(
        found.ref,
        found.capability,
        path,
        options.maxBytes,
        options.signal,
      );
      if (read.kind === "read") return read.bytes;
      if (read.kind === "missing") return undefined;
      if (read.code === "artifact.too_large")
        throw new SandboxFileTooLargeError(path, options.maxBytes + 1, options.maxBytes);
      throw new Error(read.message);
    },
  };
}
