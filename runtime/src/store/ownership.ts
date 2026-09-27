import type { SessionDoc, SessionStore, StoredSession, Tx } from "./types.js";

/**
 * An advance's transaction found the session's epoch changed: another Worker
 * took ownership. The advance aborts with no write (§10.6).
 */
export class OwnershipLostError extends Error {
  readonly code = "ownership.lost";
  constructor(
    readonly sessionId: string,
    readonly expectedEpoch: number,
    readonly actualEpoch: number | undefined,
  ) {
    super(
      actualEpoch === undefined
        ? `Session ${sessionId} is gone; ownership lost`
        : `Session ${sessionId} is at epoch ${actualEpoch}, not ${expectedEpoch}; ownership lost`,
    );
    this.name = "OwnershipLostError";
  }
}

export function isOwnershipLost(error: unknown): error is OwnershipLostError {
  return (
    error instanceof OwnershipLostError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ownership.lost")
  );
}

/**
 * An epoch-checked transaction: locks the session, checks `epoch`, then runs
 * `fn` with the locked session. A mismatch rejects with `OwnershipLostError`
 * before `fn` runs, so nothing is written.
 */
export function ownedTx<T, S extends SessionDoc = SessionDoc>(
  store: SessionStore,
  sessionId: string,
  epoch: number,
  fn: (t: Tx, session: StoredSession<S>) => Promise<T>,
): Promise<T> {
  return store.tx(async (t) => fn(t, await t.assertEpoch<S>(sessionId, epoch)));
}
