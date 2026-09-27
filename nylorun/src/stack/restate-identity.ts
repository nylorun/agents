import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { CliError } from "../errors.js";

/**
 * Restate request identity (Runtime Architecture §9.1, §12.3). Restate signs
 * every request to the Worker endpoint with an Ed25519 private key; the
 * Runtime accepts only requests that verify against the public key.
 *
 * - The private key is a PKCS#8 PEM at `stack/restate-identity.pem` (mode
 *   0600), mounted read-only into the restate service as
 *   `RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE`.
 * - The public key goes to the Runtime as `NYLORUN_RESTATE_IDENTITY_KEY`, in
 *   Restate's format: `publickeyv1_` followed by the base58btc encoding of
 *   the raw 32-byte public key. Restate logs the same string as the key id
 *   (`kid`) when it loads the PEM.
 */

export const IDENTITY_KEY_PREFIX = "publickeyv1_";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 with the Bitcoin alphabet; each leading zero byte becomes "1". */
export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Little-endian base-58 digits of the big-endian number after the zeros.
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index]!;
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += digits[digit]! * 256;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let digit = digits.length - 1; digit >= 0; digit -= 1)
    out += BASE58_ALPHABET[digits[digit]!];
  return out;
}

/** The `publickeyv1_...` string for an Ed25519 private key PEM. */
export function identityPublicKey(privateKeyPem: string): string {
  let jwk: { kty?: string; crv?: string; x?: string };
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    jwk = createPublicKey(key).export({ format: "jwk" });
  } catch (error) {
    throw new CliError(
      `The Restate identity key is not an Ed25519 PKCS#8 PEM (${error instanceof Error ? error.message : String(error)})`,
      1,
    );
  }
  const raw = Buffer.from(jwk.x ?? "", "base64url");
  if (raw.length !== 32) throw new CliError("The Restate identity public key is not 32 bytes", 1);
  return `${IDENTITY_KEY_PREFIX}${base58btc(raw)}`;
}

export function generateIdentityPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/**
 * Read the identity PEM at `path`, creating it (mode 0600) on first start, and
 * return its public key. An existing key is kept, so Restate's signatures stay
 * valid across starts.
 */
export async function ensureIdentityKey(
  path: string,
  write: (path: string, text: string, mode: number) => Promise<void>,
): Promise<{ publicKey: string; created: boolean }> {
  let pem: string | undefined;
  try {
    pem = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pem !== undefined) {
    let publicKey: string;
    try {
      publicKey = identityPublicKey(pem);
    } catch (error) {
      throw new CliError(
        `${path}: ${(error as Error).message}. Delete it and run "nylorun start" to create a new one.`,
        1,
      );
    }
    await chmod(path, 0o600);
    return { publicKey, created: false };
  }
  pem = generateIdentityPem();
  await write(path, pem, 0o600);
  return { publicKey: identityPublicKey(pem), created: true };
}
