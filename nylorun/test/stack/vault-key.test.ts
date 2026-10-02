/**
 * F4.2: `nylorun start` keeps the Tenant's vault key in `keys/vault-kek`, which only the gateway
 * container mounts. It creates the key once, keeps it across starts, and moves the key a stack
 * before F4.2 kept in `tenant/vault-kek`.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureVaultKey } from "../../src/stack/host-files.js";
import { stackPaths } from "../../src/stack/paths.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function paths() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-vault-key-"));
  roots.push(root);
  return stackPaths(root);
}

it("creates a 32-byte key, mode 0600, in a 0700 keys directory, and keeps it", async () => {
  const p = await paths();
  expect(await ensureVaultKey(p)).toEqual({ created: true, moved: false });
  const key = await readFile(p.vaultKey, "utf8");
  expect(Buffer.from(key.trim(), "base64")).toHaveLength(32);
  expect(statSync(p.vaultKey).mode & 0o777).toBe(0o600);
  expect(statSync(p.keys).mode & 0o777).toBe(0o700);
  expect(await ensureVaultKey(p)).toEqual({ created: false, moved: false });
  expect(await readFile(p.vaultKey, "utf8")).toBe(key);
});

it("moves the key a stack before F4.2 kept in tenant/", async () => {
  const p = await paths();
  await mkdir(p.tenant, { recursive: true });
  const legacy = join(p.tenant, "vault-kek");
  await writeFile(legacy, "legacy-key\n");
  expect(await ensureVaultKey(p)).toEqual({ created: false, moved: true });
  expect(existsSync(legacy)).toBe(false);
  expect(await readFile(p.vaultKey, "utf8")).toBe("legacy-key\n");
});
