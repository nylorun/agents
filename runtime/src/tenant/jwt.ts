/**
 * What subject tokens and delivery tokens share: the Tenant's ES256 JWTs, recognised by shape,
 * told apart by their `typ`, and refused before any key is read when the header is not one the
 * Runtime issues.
 */
import { decodeProtectedHeader } from "jose";
import { SIGNING_KEY_ID_PATTERN } from "@nylorun/core/compatibility";

export const MAX_TOKEN_BYTES = 4096;
export const CLOCK_TOLERANCE_SECONDS = 30;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "x5t", "crit"];

/** True when `bearer` has the shape of a JWT; application keys never do. */
export function looksLikeToken(bearer: string): boolean {
  return JWT_SHAPE.test(bearer);
}

/** The `typ` of a JWT-shaped bearer, or `undefined` when its header cannot be read. */
export function tokenType(raw: string): string | undefined {
  if (Buffer.byteLength(raw) > MAX_TOKEN_BYTES || !JWT_SHAPE.test(raw)) return undefined;
  try {
    const typ = decodeProtectedHeader(raw).typ;
    return typeof typ === "string" ? typ : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the header of a token of type `typ` is refused before any key is read, or its key id
 * when it is not: `malformed` (size, shape, undecodable) or `header` (algorithm, type, key id,
 * or a header that could name another key).
 */
export function tokenKeyId(
  raw: string,
  typ: string,
): { kid: string } | { refused: "malformed" | "header" } {
  if (Buffer.byteLength(raw) > MAX_TOKEN_BYTES || !JWT_SHAPE.test(raw))
    return { refused: "malformed" };
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(raw);
  } catch {
    return { refused: "malformed" };
  }
  if (
    header.alg !== "ES256" ||
    header.typ !== typ ||
    typeof header.kid !== "string" ||
    !SIGNING_KEY_ID_PATTERN.test(header.kid) ||
    FORBIDDEN_HEADERS.some((name) => name in header)
  )
    return { refused: "header" };
  return { kid: header.kid };
}
