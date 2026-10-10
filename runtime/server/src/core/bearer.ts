import { createHash, randomBytes } from "node:crypto";

/**
 * Application keys are 256-bit CSPRNG values and the wire schema requires at least 16
 * characters, so an unsalted digest is adequate to keep them out of the Session Store at rest.
 * This is not a password KDF and must not be used for one.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Mint a 32-byte hex application key for tests and CLI bootstrap. */
export function mintBearerToken(): string {
  return randomBytes(32).toString("hex");
}
