/**
 * Harness ids (track R4): the name a harness says in `hello`, an Environment's `harness`, and the
 * key of the Tenant's placement. A session runs the harness it pinned when it opened.
 */

/** The harness of a session that names no other: ours (`@nylorun/harness`). */
export const DEFAULT_HARNESS = "nylorun";

/** Lowercase letters, digits and dashes, starting with a letter: 2 to 63 characters. */
export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function isHarnessId(value: unknown): value is string {
  return typeof value === "string" && HARNESS_ID_PATTERN.test(value);
}
