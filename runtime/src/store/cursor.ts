/**
 * Event cursors. A cursor names the last event a client has seen:
 * `base64url("<sessionId>:<seq>")`, where `seq` is the per-session event
 * sequence and also the S2 sequence number in `sessions/<sessionId>`.
 * The encoding matches `core/store.ts`, so existing clients see no change.
 */

export function encodeCursor(sessionId: string, seq: number): string {
  return Buffer.from(`${sessionId}:${seq}`).toString("base64url");
}

/** Decodes a cursor for `sessionId`, or throws `Invalid cursor`. */
export function decodeCursor(sessionId: string, cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString();
  const prefix = `${sessionId}:`;
  const rest = decoded.slice(prefix.length);
  if (!decoded.startsWith(prefix) || !/^\d+$/.test(rest))
    throw new Error("Invalid cursor");
  return Number(rest);
}
