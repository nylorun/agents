/**
 * The Tenant's trace key (R7.2, Q3): 32 random bytes in the Tenant setting `trace.key` (base64),
 * created on first use under the signing keys' lock, as the egress CA is. It is not sealed: it
 * keys trace ids so nobody computes them from a session id, and anyone who can read the setting
 * can read the log the ids point at. Core reads it in both process modes; the gateway never
 * needs it (a tool call's `traceparent` is on its journal row, R7.4).
 *
 * Read once per store and kept: a Tenant reset keeps its settings.
 */
import { randomBytes } from "node:crypto";
import type { SessionStore, Tx } from "../store/types.js";
import type { TraceKey } from "./ids.js";

const SETTING = "trace.key";

const keys = new WeakMap<SessionStore, Promise<TraceKey>>();

/** The Tenant's trace key, creating it when the Tenant has none. Call outside a transaction. */
export function traceKey(store: SessionStore): Promise<TraceKey> {
  let key = keys.get(store);
  if (!key) {
    key = store.tx((t) => traceKeyIn(t));
    // A failed read is tried again by the next caller.
    key.catch(() => keys.delete(store));
    keys.set(store, key);
  }
  return key;
}

/** The trace key inside `t`, creating it when the Tenant has none. */
export async function traceKeyIn(t: Tx): Promise<TraceKey> {
  const existing = await t.getSetting(SETTING);
  if (existing !== undefined) return Buffer.from(existing, "base64");
  // Concurrent first uses would both create one: lock, then read what the winner made.
  await t.lockSigningKeys();
  const won = await t.getSetting(SETTING);
  if (won !== undefined) return Buffer.from(won, "base64");
  const created = randomBytes(32);
  await t.putSetting(SETTING, created.toString("base64"));
  return created;
}
