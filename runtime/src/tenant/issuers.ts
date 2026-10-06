/**
 * Trusted issuers (Host feature `trusted-issuers`, F9 I2): JWTs from the operator's own
 * identity provider, declared in the identity file (`identity-file.ts`), accepted as bearers.
 * A token is one of theirs when its unverified `iss` names a configured issuer; it is then
 * verified like this, and nothing else is tried:
 *
 * - at most 16 KiB (identity providers' tokens often pass Nylorun's 4 KiB), RS256, ES256 or
 *   EdDSA, and no header that could name another key (`jku`, `jwk`, `x5u`, `x5c`, `crit`);
 * - signed by a key of the issuer: its static `keys`, or its JWKS, fetched only from the
 *   configured URL (`redirect: "error"`), cached by `kid`, refetched at most once a minute for
 *   a `kid` it has not seen, and refreshed in the background once the cache is 10 minutes old.
 *   When the JWKS cannot be fetched, cached keys keep working and a new `kid` is
 *   `401 issuer_unavailable`;
 * - `iss` and `aud` as configured, and `exp` present, with the 30 s clock tolerance of every
 *   Runtime token. How long a token lives is the issuer's to decide (protocol 9 dropped
 *   `maxLifetime`); an `iat` in the future is still refused;
 * - a subject the template renders from scalar claims, valid and not reserved.
 *
 * The result is the `token` AuthScope (F9-D12) with `issuer`: only its expiry ends it. An
 * expired token is `401 token_expired`; every other refusal is `401 credential_invalid`
 * (`resource-server.ts`), its reason logged.
 */
import { createHash, createPublicKey } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import { isSubject, type IssuerScope } from "@nylorun/core/contracts";
import type { AuthScope, TenantContext } from "./context.js";
import { HttpError } from "./http.js";
import { CLOCK_TOLERANCE_SECONDS, looksLikeToken } from "./jwt.js";
import { bearerChallenge, failCredential } from "./resource-server.js";
import {
  ISSUER_ALGORITHMS,
  issuerKey,
  renderTemplate,
  type IssuerAlgorithm,
  type IssuerKey,
  type TrustedIssuerConfig,
} from "./identity-file.js";

/** The byte cap of an issuer's token; Nylorun's own token families keep 4 KiB. */
export const MAX_ISSUER_TOKEN_BYTES = 16 * 1024;
/** Subjects the Runtime keeps for itself: never an issuer token's. */
const RESERVED = new Set(["host", "installation"]);
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "crit"];
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;
const JWKS_MAX_KEYS = 64;
const DEFAULT_REFETCH_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
/** A grant's claim value: one sandbox id segment, so a claim never widens the template. */
const GRANT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface TrustedIssuersOptions {
  /** Fetches JWKS URLs. Default: the global fetch. */
  fetch?: typeof fetch;
  /** The least time between two JWKS fetches of one issuer for an unknown `kid`. Default 60 s. */
  refetchMs?: number;
  /** How old cached JWKS keys get before a background refresh. Default 10 minutes. */
  maxAgeMs?: number;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
}

/** What verifying an issuer's token found. */
export type IssuerVerdict =
  | { readonly ok: true; readonly payload: JWTPayload; readonly kid?: string }
  | { readonly ok: false; readonly refused: "invalid" | "expired" | "unavailable"; readonly reason: string };

/** One configured issuer, with its keys. */
export interface TrustedIssuer {
  readonly config: TrustedIssuerConfig;
  /** Checks `raw`'s header and signature, `iss`, `aud`, `exp` and `iat`. */
  verify(raw: string): Promise<IssuerVerdict>;
}

/** The Host's trusted issuers (`TenantConfig.issuers`), built once from the identity file. */
export interface TrustedIssuers {
  readonly issuers: readonly TrustedIssuer[];
  /** The issuer a JWT-shaped bearer claims by its unverified `iss`, if it is one of these. */
  claimed(raw: string): TrustedIssuer | undefined;
}

/** The issuer's public keys: static, or its JWKS's as last fetched. */
class IssuerKeys {
  private byKid = new Map<string, IssuerKey>();
  private unnamed: IssuerKey[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private okAt = Number.NEGATIVE_INFINITY;
  private lastOk: boolean | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly config: TrustedIssuerConfig,
    private readonly options: Required<TrustedIssuersOptions>,
  ) {
    for (const key of config.keys ?? []) this.unnamed.push(key);
  }

  /** The keys that may have signed a token with `kid` and `alg`, or `unavailable`. */
  async candidates(kid: string | undefined, alg: IssuerAlgorithm): Promise<IssuerKey[] | "unavailable"> {
    const usable = (key: IssuerKey) => key.alg === alg;
    // Static keys have no `kid`; a JWKS token with a `kid` is checked against that key alone.
    const pick = (): IssuerKey[] => {
      if (!this.config.jwks) return this.unnamed.filter(usable);
      if (kid !== undefined) {
        const key = this.byKid.get(kid);
        return key && usable(key) ? [key] : [];
      }
      return [...this.byKid.values(), ...this.unnamed].filter(usable);
    };
    if (!this.config.jwks) return pick();
    const now = this.options.now();
    let found = pick();
    if (found.length === 0) {
      if (this.inflight) await this.inflight;
      else if (now - this.fetchedAt >= this.options.refetchMs) await this.refresh();
      found = pick();
      if (found.length === 0 && this.lastOk === false) return "unavailable";
    } else if (now - this.okAt >= this.options.maxAgeMs && now - this.fetchedAt >= this.options.refetchMs) {
      // Old keys keep working while the refresh runs, and when it fails.
      void this.refresh();
    }
    return found;
  }

  /** Fetches the JWKS once, joining a fetch already running. A failure keeps the cache. */
  refresh(): Promise<void> {
    this.inflight ??= this.fetchKeys().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchKeys(): Promise<void> {
    const started = this.options.now();
    this.fetchedAt = started;
    try {
      const response = await this.options.fetch(this.config.jwks!, {
        redirect: "error",
        headers: { accept: "application/jwk-set+json, application/json" },
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > JWKS_MAX_BYTES) throw new Error("JWKS is too large");
      const body = JSON.parse(text) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys array");
      const byKid = new Map<string, IssuerKey>();
      const unnamed: IssuerKey[] = [];
      for (const jwk of body.keys.slice(0, JWKS_MAX_KEYS)) {
        const key = jwkKey(jwk);
        if (!key) continue;
        if (key.kid !== undefined) byKid.set(key.kid, key);
        else unnamed.push(key);
      }
      this.byKid = byKid;
      this.unnamed = unnamed;
      this.okAt = started;
      this.lastOk = true;
    } catch {
      this.lastOk = false;
    }
  }
}

/** A JWK an issuer signs with, or undefined for one the Runtime does not use. */
function jwkKey(jwk: unknown): IssuerKey | undefined {
  if (!jwk || typeof jwk !== "object") return undefined;
  const entry = jwk as { kty?: unknown; use?: unknown; alg?: unknown; kid?: unknown; d?: unknown };
  if (entry.use !== undefined && entry.use !== "sig") return undefined;
  if (entry.d !== undefined) return undefined; // a private key: never trusted as published
  if (entry.alg !== undefined && !(ISSUER_ALGORITHMS as readonly unknown[]).includes(entry.alg))
    return undefined;
  const kid = typeof entry.kid === "string" && entry.kid.length <= 256 ? entry.kid : undefined;
  try {
    const key = issuerKey(createPublicKey({ key: jwk as never, format: "jwk" }), kid);
    return entry.alg === undefined || entry.alg === key.alg ? key : undefined;
  } catch {
    return undefined;
  }
}

function trustedIssuer(config: TrustedIssuerConfig, options: Required<TrustedIssuersOptions>): TrustedIssuer {
  const keys = new IssuerKeys(config, options);
  return {
    config,
    async verify(raw) {
      const refuse = (refused: "invalid" | "expired" | "unavailable", reason: string): IssuerVerdict => ({
        ok: false,
        refused,
        reason,
      });
      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(raw);
      } catch {
        return refuse("invalid", "issuer_token_malformed");
      }
      const alg = header.alg as IssuerAlgorithm;
      if (
        !ISSUER_ALGORITHMS.includes(alg) ||
        (header.kid !== undefined && typeof header.kid !== "string") ||
        FORBIDDEN_HEADERS.some((name) => name in header)
      )
        return refuse("invalid", "issuer_token_header");
      const kid = header.kid as string | undefined;
      const candidates = await keys.candidates(kid, alg);
      if (candidates === "unavailable") return refuse("unavailable", "issuer_jwks_unavailable");
      if (candidates.length === 0) return refuse("invalid", "issuer_key_unknown");
      for (const candidate of candidates) {
        try {
          const { payload } = await jwtVerify(raw, candidate.key, {
            algorithms: [candidate.alg],
            issuer: config.issuer,
            audience: config.audience,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp"],
            currentDate: new Date(options.now()),
          });
          const now = Math.floor(options.now() / 1000);
          if (payload.iat !== undefined && payload.iat > now + CLOCK_TOLERANCE_SECONDS)
            return refuse("invalid", "issuer_token_future");
          return { ok: true, payload, ...(kid !== undefined ? { kid } : {}) };
        } catch (error) {
          // Signature checks come first: an expiry is only reported for a token the issuer signed.
          if (error instanceof errors.JWSSignatureVerificationFailed) continue;
          if (error instanceof errors.JWTExpired) return refuse("expired", "issuer_token_expired");
          return refuse("invalid", "issuer_token_invalid");
        }
      }
      return refuse("invalid", "issuer_token_signature");
    },
  };
}

/** The trusted issuers of `configs` (`parseIdentityFile`). No key is fetched until needed. */
export function createTrustedIssuers(
  configs: readonly TrustedIssuerConfig[],
  options: TrustedIssuersOptions = {},
): TrustedIssuers {
  const resolved: Required<TrustedIssuersOptions> = {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    refetchMs: options.refetchMs ?? DEFAULT_REFETCH_MS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    now: options.now ?? Date.now,
  };
  const issuers = configs.map((config) => trustedIssuer(config, resolved));
  const byIss = new Map(issuers.map((issuer) => [issuer.config.issuer, issuer]));
  return {
    issuers,
    claimed(raw) {
      if (byIss.size === 0 || Buffer.byteLength(raw) > MAX_ISSUER_TOKEN_BYTES || !looksLikeToken(raw))
        return undefined;
      try {
        const iss = decodeJwt(raw).iss;
        return typeof iss === "string" ? byIss.get(iss) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** A claim's value as template text: strings and finite numbers only (scalar claims). */
function scalarClaim(payload: JWTPayload, claim: string): string | undefined {
  if (!Object.hasOwn(payload, claim)) return undefined;
  const value = payload[claim];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function scopesOf(config: TrustedIssuerConfig, payload: JWTPayload): Set<IssuerScope> {
  let names: unknown[] = [];
  if ("fixed" in config.scopes) names = [...config.scopes.fixed];
  else if (Object.hasOwn(payload, config.scopes.claim)) {
    const value = payload[config.scopes.claim];
    if (typeof value === "string") names = value.split(" ");
    else if (Array.isArray(value)) names = value;
  }
  return new Set(
    config.allowedScopes.filter((scope) => names.includes(scope)),
  );
}

export type IssuerTokenScope = Extract<AuthScope, { kind: "token" }>;

/**
 * Verifies a bearer that `issuer` claims (`TrustedIssuers.claimed`). Returns the request's
 * scope; answers `401 token_expired` for an expired token, `401 issuer_unavailable` for a key
 * the Runtime cannot fetch now, and `401 credential_invalid` for everything else. Each carries
 * a `Bearer` challenge naming `resourceMetadata`, the route's protected resource metadata.
 */
export async function verifyIssuerToken(
  ctx: TenantContext,
  issuer: TrustedIssuer,
  raw: string,
  resourceMetadata?: string,
): Promise<IssuerTokenScope> {
  const { config } = issuer;
  const rejected = (reason: string): never => {
    ctx.config.logger.warn("credential rejected", { reason, issuer: config.name });
    return failCredential("invalid", resourceMetadata);
  };
  const verdict = await issuer.verify(raw);
  if (!verdict.ok) {
    if (verdict.refused === "expired") {
      ctx.config.logger.warn("issuer token refused", { reason: verdict.reason, issuer: config.name });
      throw new HttpError(
        401,
        "The token has expired",
        { code: "token_expired" },
        {
          "www-authenticate": bearerChallenge({
            error: "invalid_token",
            description: "The access token expired",
            resourceMetadata,
          }),
        },
      );
    }
    if (verdict.refused === "unavailable") {
      ctx.config.logger.warn("issuer token refused", { reason: verdict.reason, issuer: config.name });
      // The token may be fine: no error code, so a client retries rather than signs in again.
      throw new HttpError(
        401,
        `The keys of issuer ${config.name} cannot be fetched now; try again later`,
        { code: "issuer_unavailable" },
        { "www-authenticate": bearerChallenge({ resourceMetadata }) },
      );
    }
    return rejected(verdict.reason);
  }
  const { payload } = verdict;
  const subject = renderTemplate(config.subject, (claim) => scalarClaim(payload, claim));
  if (subject === undefined || !isSubject(subject) || RESERVED.has(subject))
    return rejected("issuer_token_subject");
  const sandboxes = config.sandboxes?.flatMap((grant) => {
    const rendered = renderTemplate(grant, (claim) => {
      const value = scalarClaim(payload, claim);
      return value !== undefined && GRANT_SEGMENT.test(value) ? value : undefined;
    });
    // A grant whose claim is missing or not one id segment reaches nothing.
    return rendered === undefined ? [] : [rendered];
  });
  const jti = typeof payload.jti === "string" && payload.jti.length > 0 && payload.jti.length <= 200
    ? payload.jti
    : createHash("sha256").update(raw).digest("base64url");
  return {
    kind: "token",
    issuer: config.name,
    subject,
    scopes: scopesOf(config, payload),
    agents: config.agents ? new Set(config.agents) : "*",
    sandboxes: [...new Set(sandboxes ?? [])],
    expiresAt: payload.exp! * 1000,
    tokenId: jti,
    ...(verdict.kid !== undefined ? { keyId: verdict.kid } : {}),
  };
}
