import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { EffectIntent } from "./messages.js";

/**
 * What an effect's journal row must match on replay. A delegation's context carries only the
 * parent's tool call id, for its events; rows journaled before it existed still match.
 */
export function requestIdentity<T extends Pick<EffectIntent, "kind" | "context">>(
  request: T
): Omit<T, "context"> | T {
  if (request.kind !== "delegation") return request;
  const { context: _, ...identity } = request;
  return identity;
}

/**
 * The SHA-256 of an effect's identity, canonical JSON (keys sorted by code unit, `undefined`
 * members dropped). Hashed with the model call's prompt, so a replay that would send another
 * prompt under the same effect id is drift, though the prompt itself is never sent twice.
 */
export function effectRequestHash(request: Pick<EffectIntent, "kind" | "context">): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(requestIdentity(request)))));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) members.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
