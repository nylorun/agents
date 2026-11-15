import { createPrivateKey, createPublicKey } from "node:crypto";

/**
 * Restate's request identity key in its own format (`publickeyv1_` and the base58btc encoding of
 * the raw 32-byte Ed25519 public key), from a PEM: Restate's PKCS#8 private key, as the Helm chart
 * mounts it, or the SPKI public key. `nylorun start` computes the same string
 * (cli/nylorun/src/stack/restate-identity.ts) and passes it as NYLORUN_RESTATE_IDENTITY_KEY.
 */
export function restateIdentityKeyOf(pem: string): string {
  const text = pem.trim();
  const key = text.includes("PRIVATE KEY") ? createPublicKey(createPrivateKey(text)) : createPublicKey(text);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  const raw = Buffer.from(key.export({ format: "jwk" }).x ?? "", "base64url");
  if (raw.length !== 32) throw new Error("the public key is not 32 bytes");
  return `publickeyv1_${base58btc(raw)}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 with the Bitcoin alphabet; each leading zero byte becomes "1". */
export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
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
  for (let digit = digits.length - 1; digit >= 0; digit -= 1) out += BASE58_ALPHABET[digits[digit]!];
  return out;
}
