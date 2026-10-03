import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ResetScope, SessionStore } from "../store/types.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { TenantPaths } from "./types.js";
import { detachAllSessions } from "./sandboxes.js";

export type { ResetScope } from "../store/types.js";

export interface ResetTenantContext {
  store: SessionStore;
  sandbox: SandboxManager;
  paths: TenantPaths;
  /** Clear in-memory session observers after the store wipe. */
  clearSessionState: () => void;
}

/**
 * Rename `dir` to a sibling, delete the sibling, recreate an empty `dir`.
 * Failure before rename leaves the original intact; after rename the empty
 * target is restored so the Tenant layout stays valid (A17).
 */
function replaceDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const sibling = `${dir}.resetting`;
  if (existsSync(sibling)) rmSync(sibling, { recursive: true, force: true });
  renameSync(dir, sibling);
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(sibling, { recursive: true, force: true });
  } catch (error) {
    // Best-effort restore if recreation failed.
    if (!existsSync(dir) && existsSync(sibling)) {
      try {
        renameSync(sibling, dir);
      } catch {
        /* leave sibling for operator inspection */
      }
    }
    throw error;
  }
}

/**
 * Reset Tenant durable state for `scope` (A17).
 * Caller must have already drained (`activeWork`). Deletes store state in one
 * transaction (`Tx.reset`), then does the filesystem rename+delete for sandboxes /
 * log as needed. The host vault (model credentials), principals and settings stay.
 */
export async function resetTenant(
  ctx: ResetTenantContext,
  scope: ResetScope,
): Promise<void> {
  const clearSessions = scope === "sessions" || scope === "all";
  const clearSandboxes = scope === "sandboxes" || scope === "all";
  const clearAll = scope === "all";

  if (clearSandboxes) {
    await ctx.sandbox.reconcile(() => false, () => false);
  }

  await ctx.store.tx(async (t) => {
    // Sandbox resources outlive their sessions: a sessions reset only detaches them.
    if (clearSessions && !clearSandboxes) await detachAllSessions(t);
    await t.reset(scope);
  });

  if (clearSessions) ctx.clearSessionState();

  if (clearSandboxes) replaceDirectory(ctx.paths.sandboxes);

  if (clearAll) {
    mkdirSync(ctx.paths.logs, { recursive: true });
    const logSibling = join(ctx.paths.logs, "tenant.log.resetting");
    if (existsSync(ctx.paths.log)) {
      if (existsSync(logSibling)) rmSync(logSibling, { force: true });
      renameSync(ctx.paths.log, logSibling);
      try {
        writeFileSync(ctx.paths.log, "");
        rmSync(logSibling, { force: true });
      } catch (error) {
        if (!existsSync(ctx.paths.log) && existsSync(logSibling)) {
          try {
            renameSync(logSibling, ctx.paths.log);
          } catch {
            /* leave sibling */
          }
        }
        throw error;
      }
    } else {
      writeFileSync(ctx.paths.log, "");
    }
  }
}
