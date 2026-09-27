import type { SessionDoc, StoredSession, Tx } from "../types.js";

/**
 * Locks several sessions in one transaction without risking a deadlock.
 *
 * Postgres row locks are taken in the order statements run. Two transactions
 * that lock sessions `a` then `b` and `b` then `a` can deadlock, and Postgres
 * aborts one with `40P01`. Every transaction that touches more than one
 * session therefore locks all of them first, in ascending id order (UTF-16
 * code unit order, the same order `lockSessions` uses everywhere), and only
 * then writes. Duplicate ids are locked once.
 *
 * Returns each id's session, or undefined when it does not exist.
 */
export async function lockSessions<T extends SessionDoc = SessionDoc>(
  t: Tx,
  ids: Iterable<string>,
): Promise<Map<string, StoredSession<T> | undefined>> {
  const locked = new Map<string, StoredSession<T> | undefined>();
  for (const id of lockOrder(ids)) locked.set(id, await t.lockSession<T>(id));
  return locked;
}

/** The order `lockSessions` locks in: unique ids, ascending. */
export function lockOrder(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
