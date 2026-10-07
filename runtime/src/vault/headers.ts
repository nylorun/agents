/**
 * The headers a vault credential may send (R2b C2): a `headers` credential's names and an
 * identity header. The core schema checks their syntax; this module refuses the names the
 * Runtime sets itself, so a credential can never replace them.
 */
import { VaultError } from "./error.js";

/** Headers the MCP transport and the HTTP tool call own. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "idempotency-key",
]);

/** True when a credential may not send `name`: a transport header or `Nylorun-*`. */
export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.has(lower) || lower.startsWith("nylorun-");
}

/**
 * The header names a credential sends, lower-cased: a `headers` map's, `authorization` for a
 * `bearer`. Refuses a reserved name, and an identity header that repeats one of them.
 */
export function checkCredentialHeaders(
  names: readonly string[],
  identity: { readonly header: string } | undefined,
): string[] {
  const lower = names.map((name) => name.toLowerCase());
  for (const name of lower)
    if (isReservedHeader(name)) throw new VaultError(400, `A credential may not set the header ${name}`);
  if (identity) {
    const header = identity.header.toLowerCase();
    if (isReservedHeader(header))
      throw new VaultError(400, `The identity header may not be ${header}`);
    if (lower.includes(header))
      throw new VaultError(400, `The identity header ${header} is already one of the credential's headers`);
  }
  return lower;
}
