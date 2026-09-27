/**
 * First start after the Postgres switch: Tenant directories of the SQLite Runtime (they hold a
 * `tenant.sqlite`) are not migrated. The Host moves them to `trash/` and logs each, so no
 * Postgres Tenant ever uses one.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { tenantPaths, trashSqliteTenants } from "../../src/tenant/paths.js";
import type { Logger } from "../../src/tenant/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function recordingLogger() {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (message, fields) => void lines.push({ level: "info", message, fields }),
    warn: (message, fields) => void lines.push({ level: "warn", message, fields }),
    error: (message, fields) => void lines.push({ level: "error", message, fields }),
  };
  return { logger, lines };
}

it("moves SQLite Tenant directories to trash/ with a log line, and leaves the rest", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-sqlite-trash-"));
  roots.push(hostRoot);
  const old = newTenantId();
  const oldDir = join(hostRoot, "tenants", old);
  mkdirSync(join(oldDir, "logs"), { recursive: true });
  writeFileSync(join(oldDir, "tenant.sqlite"), "SQLite format 3\0");
  writeFileSync(join(oldDir, "tenant.json"), "{}");
  // A Postgres Tenant's directory: no tenant.sqlite.
  const current = newTenantId();
  const currentPaths = tenantPaths(hostRoot, current);
  mkdirSync(currentPaths.pluginData, { recursive: true });
  writeFileSync(currentPaths.kek, "key\n");

  const { logger, lines } = recordingLogger();
  expect(trashSqliteTenants(hostRoot, logger)).toEqual([old]);

  expect(existsSync(oldDir)).toBe(false);
  const trashed = readdirSync(join(hostRoot, "trash"));
  expect(trashed).toHaveLength(1);
  expect(trashed[0]!.startsWith(`${old}-sqlite-`)).toBe(true);
  expect(existsSync(join(hostRoot, "trash", trashed[0]!, "tenant.sqlite"))).toBe(true);
  expect(lines).toEqual([
    expect.objectContaining({
      level: "warn",
      message: "sqlite_tenant_moved_to_trash",
      fields: expect.objectContaining({ tenant: old }),
    }),
  ]);

  expect(existsSync(currentPaths.kek)).toBe(true);
  // A second start finds nothing more to move.
  expect(trashSqliteTenants(hostRoot, logger)).toEqual([]);
  expect(lines).toHaveLength(1);
});

it("does nothing on a Host root without tenants/", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-sqlite-trash-"));
  roots.push(hostRoot);
  const { logger, lines } = recordingLogger();
  expect(trashSqliteTenants(hostRoot, logger)).toEqual([]);
  expect(existsSync(join(hostRoot, "trash"))).toBe(false);
  expect(lines).toEqual([]);
});
