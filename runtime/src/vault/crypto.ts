import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultCryptoError extends Error {
  constructor() {
    super("Vault credential could not be read");
  }
}

export function kekId(kek: Buffer): string {
  return createHash("sha256").update(kek).digest("hex");
}

export function parseKek(value: Buffer | string): Buffer {
  const bytes =
    typeof value === "string" ? Buffer.from(value.trim(), "base64") : value;
  if (bytes.length !== 32)
    throw new Error("Vault key-encryption key must be 32 bytes");
  return Buffer.from(bytes);
}

export function encryptSecret(
  kek: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { nonce: Buffer; ciphertext: Buffer; wrappedDek: Buffer; kekId: string } {
  const dek = randomBytes(32);
  try {
    const nonce = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      nonce,
      ciphertext: Buffer.concat([body, tag]),
      wrappedDek: wrapKey(kek, dek),
      kekId: kekId(kek),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(
  kek: Buffer,
  aad: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  wrappedDek: Buffer,
  expectedKekId: string,
): Buffer {
  if (expectedKekId !== kekId(kek)) throw new VaultCryptoError();
  const dek = unwrapKey(kek, wrappedDek);
  try {
    if (ciphertext.length < TAG_BYTES) throw new VaultCryptoError();
    const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
    const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    if (error instanceof VaultCryptoError) throw error;
    throw new VaultCryptoError();
  } finally {
    dek.fill(0);
  }
}

function wrapKey(kek: Buffer, dek: Buffer): Buffer {
  const nonce = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function unwrapKey(kek: Buffer, wrapped: Buffer): Buffer {
  try {
    if (wrapped.length < IV_BYTES + TAG_BYTES) throw new VaultCryptoError();
    const nonce = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(wrapped.length - TAG_BYTES);
    const body = wrapped.subarray(IV_BYTES, wrapped.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new VaultCryptoError();
  }
}

/** The wrapped DEK's length: its nonce, the 32-byte key and the tag. */
const WRAPPED_DEK_BYTES = IV_BYTES + 32 + TAG_BYTES;

/**
 * `encryptSecret` in one column: nonce, wrapped DEK, then ciphertext and tag. For rows that
 * seal several short secrets under one `kekId` (`oauth_pending`, F9 C2).
 */
export function sealBytes(kek: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const sealed = encryptSecret(kek, aad, plaintext);
  return Buffer.concat([sealed.nonce, sealed.wrappedDek, sealed.ciphertext]);
}

/** Opens what `sealBytes` sealed; `VaultCryptoError` when it cannot. */
export function openBytes(kek: Buffer, aad: Buffer, sealed: Buffer, expectedKekId: string): Buffer {
  if (sealed.length < IV_BYTES + WRAPPED_DEK_BYTES + TAG_BYTES) throw new VaultCryptoError();
  return decryptSecret(
    kek,
    aad,
    sealed.subarray(0, IV_BYTES),
    sealed.subarray(IV_BYTES + WRAPPED_DEK_BYTES),
    sealed.subarray(IV_BYTES, IV_BYTES + WRAPPED_DEK_BYTES),
    expectedKekId,
  );
}
