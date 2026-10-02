/**
 * Verifies the delivery token on a request the Runtime sends to an Action endpoint: an ES256
 * JWT signed with the Tenant's current signing key (design: Action endpoints §8.1). WebCrypto
 * only, so the SDK takes no JWT dependency: a JWS ES256 signature is the raw `r || s` pair
 * WebCrypto's ECDSA verifies.
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { DELIVERY_TOKEN_TYPE, subjectTokenIssuer } from "@nylorun/core/contracts";

/** The claims of a verified delivery token. */
export interface DeliveryClaims {
  readonly iss: string;
  readonly aud: string;
  /** The Action id, or `ping`. */
  readonly sub: string;
  /** The agent or workflow the Action belongs to. */
  readonly agt: string;
  /** The delivery's generation; `0` for a ping. */
  readonly gen: number;
  /** base64url SHA-256 of the request body. */
  readonly bdy: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

/** Why a delivery was refused; `code` is sent back to the Runtime. */
export class DeliveryVerificationError extends Error {
  override readonly name = "DeliveryVerificationError";
  constructor(
    readonly code: "signature_missing" | "signature_invalid" | "key_unknown" | "token_expired",
    message: string,
  ) {
    super(message);
  }
}

/** Finds the public key for a `kid`, or `undefined` when the Tenant has none. */
export type KeyLookup = (kid: string) => Promise<CryptoKey | undefined>;

/** Clock skew tolerated on `iat` and `exp`, in seconds. */
const SKEW_SECONDS = 30;
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "x5t", "x5t#S256", "crit"];
/** The largest token accepted: well above a real one, well below a request limit. */
const MAX_TOKEN_LENGTH = 4096;

export async function verifyDeliveryToken(
  token: string | null,
  options: {
    keys: KeyLookup;
    tenantId: string;
    body: Uint8Array;
    /** When set, `aud` must equal it: the URL this endpoint was registered with. */
    audience?: string;
    now?: number;
  },
): Promise<DeliveryClaims> {
  if (!token) throw new DeliveryVerificationError("signature_missing", "No delivery token");
  const parts = token.length <= MAX_TOKEN_LENGTH ? token.split(".") : [];
  if (parts.length !== 3) throw invalid("Not a compact JWS");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = json(encodedHeader);
  if (
    header.alg !== "ES256" ||
    header.typ !== DELIVERY_TOKEN_TYPE ||
    typeof header.kid !== "string" ||
    FORBIDDEN_HEADERS.some((name) => name in header)
  )
    throw invalid("Unexpected token header");
  const key = await options.keys(header.kid);
  if (!key)
    throw new DeliveryVerificationError("key_unknown", `Unknown signing key ${header.kid}`);
  const signed = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    bytes(base64url(encodedSignature)),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signed) throw invalid("Bad signature");
  const claims = json(encodedPayload);
  if (
    typeof claims.iss !== "string" ||
    typeof claims.aud !== "string" ||
    typeof claims.sub !== "string" ||
    typeof claims.agt !== "string" ||
    !Number.isInteger(claims.gen) ||
    typeof claims.bdy !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    typeof claims.jti !== "string"
  )
    throw invalid("Missing claims");
  if (claims.iss !== subjectTokenIssuer(options.tenantId))
    throw invalid("The token is for another Tenant");
  if (options.audience !== undefined && claims.aud !== options.audience)
    throw invalid(`The token is for ${claims.aud}, not ${options.audience}`);
  const now = (options.now ?? Date.now()) / 1000;
  if (claims.exp < now - SKEW_SECONDS || claims.iat > now + SKEW_SECONDS)
    throw new DeliveryVerificationError("token_expired", "The delivery token has expired");
  if (claims.bdy !== (await bodyHash(options.body)))
    throw invalid("The body does not match the token");
  return claims as unknown as DeliveryClaims;
}

/** base64url SHA-256 of `body`: the token's `bdy` claim. */
export async function bodyHash(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(body)));
  return Buffer.from(digest).toString("base64url");
}

/**
 * The Tenant's public keys, fetched from `GET /v1/access/jwks` and cached by `kid`. An
 * unknown `kid` refetches once, at most every `refetchMs`, so forged tokens cannot make the
 * endpoint call the Runtime on every request. Concurrent lookups share one in-flight fetch.
 */
export class JwksCache {
  private readonly keys = new Map<string, CryptoKey>();
  private lastFetch = 0;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly source:
      | { url: string; tenant: string; key?: string; fetch?: typeof fetch }
      | { keys: readonly JsonWebKey[] },
    private readonly refetchMs = 5000,
  ) {}

  readonly lookup: KeyLookup = async (kid) => {
    const known = this.keys.get(kid);
    if (known) return known;
    // Wait for an in-flight fetch: stamping the cooldown at the start of `load` used
    // to make a concurrent ping (register + smoke, or tsx watch restart) answer
    // `key_unknown` before the keys arrived.
    if (this.pending) {
      await this.pending;
      return this.keys.get(kid);
    }
    if (Date.now() - this.lastFetch < this.refetchMs && this.lastFetch > 0) return undefined;
    await (this.pending ??= this.load().finally(() => (this.pending = undefined)));
    return this.keys.get(kid);
  };

  private async load(): Promise<void> {
    const keys = "keys" in this.source ? this.source.keys : await this.fetchKeys(this.source);
    this.lastFetch = Date.now();
    for (const jwk of keys) {
      const kid = (jwk as { kid?: unknown }).kid;
      if (typeof kid !== "string" || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
      if (this.keys.has(kid)) continue;
      this.keys.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        ),
      );
    }
  }

  private async fetchKeys(source: {
    url: string;
    tenant: string;
    key?: string;
    fetch?: typeof fetch;
  }): Promise<readonly JsonWebKey[]> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: source.tenant,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    };
    if (source.key) headers.Authorization = `Bearer ${source.key}`;
    const response = await (source.fetch ?? globalThis.fetch)(
      `${source.url.replace(/\/$/, "")}/v1/access/jwks`,
      { headers, redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `The Runtime answered ${response.status} for its public keys (GET /v1/access/jwks)`,
      );
    }
    const body = (await response.json()) as { keys?: unknown };
    return Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : [];
  }
}

function invalid(message: string): DeliveryVerificationError {
  return new DeliveryVerificationError("signature_invalid", message);
}

function base64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** A copy backed by a plain `ArrayBuffer`, which WebCrypto's types require. */
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function json(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw invalid("Malformed token");
}
