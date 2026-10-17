/**
 * Harness ids: the name a harness says in `hello`, an Environment's `harness`, and the
 * key of the Tenant's placement. A session runs the harness it pinned when it opened.
 */

/** The harness of a session that names no other: ours (`@nylorun/harness`). */
export const DEFAULT_HARNESS = "nylorun";

/**
 * Lowercase letters, digits and dashes, starting with a letter: 2 to 63 characters, an RFC 1123
 * DNS label's length; an identifier's grammar is the protocol's (it crosses the Runtime API, the Harness API and tokens, and means the same in every installation), so its length is a constant of protocol 15, not a setting.
 */
export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function isHarnessId(value: unknown): value is string {
  return typeof value === "string" && HARNESS_ID_PATTERN.test(value);
}
