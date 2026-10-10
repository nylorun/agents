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

/**
 * The secret values of a credential's `headers`, as a server could echo them (R2b C8, Q16): each
 * value of at least 8 characters, and the token of a `Bearer …` value. The identity header names
 * the session owner and is no secret, so it is left out.
 */
export function credentialSecrets(
  headers: Readonly<Record<string, string>>,
  identity?: { readonly header: string },
): string[] {
  const skip = identity?.header.toLowerCase();
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === skip) continue;
    if (value.length >= 8) secrets.add(value);
    const bearer = /^bearer\s+(\S+)\s*$/iu.exec(value)?.[1];
    if (bearer !== undefined && bearer.length >= 8) secrets.add(bearer);
  }
  return [...secrets];
}

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
