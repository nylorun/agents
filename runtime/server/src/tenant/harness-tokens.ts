/**
 * Per-harness tokens (R4.1): the credential a custom harness's container connects to the Harness
 * API listener with. Each is bound to one harness id, so a harness can only say that id in
 * `hello` and only take the sessions pinned to it. Our harness keeps the installation's
 * `NYLORUN_HARNESS_TOKEN`, bound to `nylorun`; a pod's harness holds neither (it joins).
 *
 * The Tenant setting `harness.tokens` keeps each token's sha256 and when it was made, never the
 * token: `nylorun-operate harness token put <id>` prints it once. Putting an id again rotates its
 * token; the old one stops working at its next connection.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_HARNESS, isHarnessId } from "@nylorun/core/contracts";
import type { SessionStore } from "../store/types.js";

export const HARNESS_TOKENS_SETTING = "harness.tokens";

interface Stored {
  readonly sha256: string;
  readonly createdAt: string;
}

export interface HarnessTokenInfo {
  readonly id: string;
  readonly createdAt: string;
}

export type HarnessTokenRefusal = { readonly reason: "invalid_id"; readonly message: string };

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

async function read(store: SessionStore): Promise<Record<string, Stored>> {
  const raw = await store.tx((t) => t.getSetting(HARNESS_TOKENS_SETTING));
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, Stored>);
}

/** The harness id `token` is for, or undefined when it is none of the Tenant's harness tokens. */
export async function harnessOfToken(store: SessionStore, token: string): Promise<string | undefined> {
  const hash = Buffer.from(sha256(token), "hex");
  for (const [id, stored] of Object.entries(await read(store))) {
    const candidate = Buffer.from(stored.sha256, "hex");
    if (candidate.length === hash.length && timingSafeEqual(candidate, hash)) return id;
  }
  return undefined;
}

/** Creates or rotates harness `id`'s token; the token is returned this once. */
export async function putHarnessToken(
  store: SessionStore,
  id: string,
): Promise<{ id: string; token: string; rotated: boolean } | HarnessTokenRefusal> {
  if (!isHarnessId(id))
    return { reason: "invalid_id", message: `${id} is not a harness id: lowercase letters, digits and dashes, starting with a letter` };
  if (id === DEFAULT_HARNESS)
    return { reason: "invalid_id", message: `${DEFAULT_HARNESS} is our harness: it connects with NYLORUN_HARNESS_TOKEN` };
  const token = randomBytes(32).toString("hex");
  return store.tx(async (t) => {
    const raw = await t.getSetting(HARNESS_TOKENS_SETTING);
    const tokens = raw === undefined ? {} : (JSON.parse(raw) as Record<string, Stored>);
    const rotated = id in tokens;
    tokens[id] = { sha256: sha256(token), createdAt: new Date().toISOString() };
    await t.putSetting(HARNESS_TOKENS_SETTING, JSON.stringify(tokens));
    return { id, token, rotated };
  });
}

export async function listHarnessTokens(store: SessionStore): Promise<HarnessTokenInfo[]> {
  return Object.entries(await read(store))
    .map(([id, stored]) => ({ id, createdAt: stored.createdAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deletes harness `id`'s token; whether there was one. */
export async function deleteHarnessToken(store: SessionStore, id: string): Promise<boolean> {
  return store.tx(async (t) => {
    const raw = await t.getSetting(HARNESS_TOKENS_SETTING);
    const tokens = raw === undefined ? {} : (JSON.parse(raw) as Record<string, Stored>);
    if (!(id in tokens)) return false;
    delete tokens[id];
    await t.putSetting(HARNESS_TOKENS_SETTING, JSON.stringify(tokens));
    return true;
  });
}
