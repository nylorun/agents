import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseKek } from "./crypto.js";

/**
 * Read the Tenant vault KEK from an explicit value or file path.
 * No environment override (A7).
 */
export function readVaultKek(options: {
  vaultKek?: Buffer | string | null;
  vaultKekPath: string;
}): Buffer | undefined {
  if (options.vaultKek === null) return undefined;
  if (options.vaultKek !== undefined) return parseKek(options.vaultKek);
  if (!existsSync(options.vaultKekPath)) return undefined;
  return parseKek(readFileSync(options.vaultKekPath, "utf8"));
}

export function createKekFile(path: string): Buffer {
  const bytes = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${bytes.toString("base64")}\n`, { mode: 0o600 });
  return bytes;
}
