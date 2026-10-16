/**
 * Webhook signing secrets (track T4, D75): the keys service makes a trigger's Standard Webhooks
 * secret, seals it with the Tenant's vault key for the trigger's row, and is the only place that
 * opens it, to verify a delivery. The secret leaves keys once, when it is made, for its owner.
 *
 * Standard Webhooks (https://www.standardwebhooks.com): the secret is `whsec_` and the base64 of
 * its key bytes; a delivery's `webhook-signature` is space-separated `v1,<base64>` entries, each an
 * HMAC-SHA256 with the key over `<webhook-id>.<webhook-timestamp>.<body>`. One that matches, in
 * constant time, verifies it. The timestamp's tolerance is the route's to check.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "../vault/crypto.js";

/** The Standard Webhooks secret format: the prefix, and 32 random bytes of key. */
const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;

/** A secret sealed with the vault key, as the trigger's row keeps it. */
export interface SealedWebhookSecret {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly wrappedDek: string;
  readonly kekId: string;
}

/** What a delivery says, as it arrived: its headers, and its body in base64. */
export interface WebhookDelivery {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly body: string;
}

const aadOf = (agentId: string, triggerId: string) => Buffer.from(`nylorun-webhook:${agentId}:${triggerId}`, "utf8");

/** A new secret for Agent `agentId`'s trigger `triggerId`, and the same sealed for its row. */
export function makeWebhookSecret(kek: Buffer, agentId: string, triggerId: string): { secret: string; sealed: SealedWebhookSecret } {
  const key = randomBytes(SECRET_BYTES);
  try {
    const sealed = encryptSecret(kek, aadOf(agentId, triggerId), key);
    return {
      secret: `${SECRET_PREFIX}${key.toString("base64")}`,
      sealed: {
        nonce: sealed.nonce.toString("base64"),
        ciphertext: sealed.ciphertext.toString("base64"),
        wrappedDek: sealed.wrappedDek.toString("base64"),
        kekId: sealed.kekId,
      },
    };
  } finally {
    key.fill(0);
  }
}

/** The signature of `delivery`'s id, timestamp and body with `key` (base64). */
export function signWebhook(key: Buffer, id: string, timestamp: string, body: Buffer): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
}

/** The key bytes of a `whsec_` secret. */
export function webhookKeyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
}

/** Whether `delivery` carries a signature the sealed secret made. */
export function verifyWebhook(
  kek: Buffer,
  agentId: string,
  triggerId: string,
  sealed: SealedWebhookSecret,
  delivery: WebhookDelivery,
): boolean {
  const key = decryptSecret(
    kek,
    aadOf(agentId, triggerId),
    Buffer.from(sealed.nonce, "base64"),
    Buffer.from(sealed.ciphertext, "base64"),
    Buffer.from(sealed.wrappedDek, "base64"),
    sealed.kekId,
  );
  try {
    const expected = Buffer.from(signWebhook(key, delivery.id, delivery.timestamp, Buffer.from(delivery.body, "base64")), "base64");
    for (const entry of delivery.signature.split(" ")) {
      const [version, value] = entry.split(",", 2);
      if (version !== "v1" || !value) continue;
      const given = Buffer.from(value, "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    return false;
  } finally {
    key.fill(0);
  }
}
