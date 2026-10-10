/**
 * The Kubernetes name of a pod sandbox's incarnation: `sbx-<lowercase base32(sha256(
 * "<tenant>/<id>"))[:16]>-g<volumeGen>`, as the sandboxes service computes it (`driver.Name` in
 * Go; `podName("shop", "sbx_01", 0)` is `sbx-ub6g5m7mvjlct6r7-g0`). A reset bumps the volume
 * generation, so each volume belongs to one name.
 */
import { createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function podName(tenantId: string, sandboxId: string, volumeGen: number): string {
  const digest = createHash("sha256").update(`${tenantId}/${sandboxId}`).digest();
  return `sbx-${base32(digest).slice(0, 16)}-g${volumeGen}`;
}
