export { hashManifest } from "./utils/hash.js";

/**
 * Protocol 8: the Runtime and Management APIs (`key_role_mismatch`), and manifest-only agents
 * (track R2): manifest v5 and workflow manifest v3, no hooks or flow functions, remote MCP
 * only, and no Action endpoints (`/v1/endpoints` and `/v1/actions/*` answer 404, delivery
 * tokens are gone): an agent's tools are HTTP tools, remote MCP servers, agents and the
 * Runtime's built-ins.
 * Protocol 7: open-source auth (F9 I3). Subject tokens (`POST /v1/tokens`), the access policy,
 * revocations, browser keys (`Nylorun-Key`), the Runtime's own CORS and derived principals are gone; their
 * routes answer 404. Browsers and apps present a trusted issuer's token, servers an operator key.
 * Protocol 6: file artifacts (`/v1/artifacts/**`, Runtime-signed capability links) and user
 * messages with `parts`. Protocol 5: a Host serves one Tenant, and nothing in a request selects
 * it. The Host still accepts protocol 4 (and `Nylorun-Tenant`), 5 and 6 clients on every route
 * that remains; a client that requires `action-endpoints` is refused by the feature check.
 */
export const PROTOCOL_VERSION = 8;
/** What a client of this protocol requires of a Host. */
export const PROTOCOL_FEATURES = [
  "studio-principal",
  "artifacts",
  /**
   * Protocol 8: the Management API (`/v1/tenant/*`) takes management keys only, and the
   * Runtime API application keys only (`key_role_mismatch`); vaults and signing keys are under
   * `/v1/tenant`.
   */
  "management-api",
] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
/**
 * Host features no client requires: a client that uses one checks the Host's `/health`
 * for it first. `tenant-fixture-model`: `PUT /v1/tenant/config/seed` accepts
 * `fixtureModel: true` (the Tenant's model calls use the Runtime's fixture model).
 * `transcript-events`: the log carries `message.assistant` and `tool.completed`.
 * `subject-headers`: an application principal may act for a subject with `Nylorun-Subject` and `Nylorun-Scopes`, and the Runtime
 * enforces the scopes and the subject's ownership of sessions. `ag-ui-endpoint`: the Runtime
 * serves AG-UI at `/v1/ag-ui/agents/:agent` for a person named by a trusted issuer's token or
 * by subject headers. `a2a-endpoint`:
 * `POST /v1/a2a/agents/:agent` answers A2A 1.0 JSON-RPC for a subject, and
 * `GET /v1/a2a/agents/:agent/card` returns the agent's card without its interfaces.
 * `sandboxes`: sandboxes are a resource (`PUT`/`GET`/`DELETE /v1/sandboxes/{id}`, kind `virtual`), a session attaches to one
 * with `sandbox: { id }`, a token caller (a trusted issuer's token) carries sandbox grants
 * checked at every turn start, and `sandboxes:write` lets a subject create and delete the
 * sandboxes it is granted.
 * `sandbox-pods`: kind `pod` runs as an agent-sandbox pod on the Tenant's cluster (`nylorun
 * sandbox enable`), with `POST /v1/sandboxes/{id}/stop` and `/reset`, a TTL
 * (`lifecycle.ttl`), lifecycle events (`sandbox.running`, `.suspended`, `.expired`,
 * `.relaunched`, `.lost`, `.reset`, `.failed`) and the Tenant's `placement`.
 * `trusted-issuers`: the Tenant API accepts JWTs from the issuers of the Host's identity file
 * (`NYLORUN_IDENTITY_FILE`) as bearers, from servers and from browsers alike, with the
 * issuer's subject, scopes (and the issuer-only `studio`), agents and sandbox grants; `GET
 * /v1/me` reports who any credential is.
 */
export const OPTIONAL_HOST_FEATURES = [
  "tenant-fixture-model",
  "transcript-events",
  "subject-headers",
  "ag-ui-endpoint",
  "a2a-endpoint",
  "sandboxes",
  "sandbox-pods",
  "trusted-issuers",
  "session-reads",
  "calls-export",
] as const;
export type OptionalHostFeature = (typeof OPTIONAL_HOST_FEATURES)[number];
export interface ProtocolRange {
  min: number;
  max: number;
  features: readonly string[];
}
/**
 * What this Host serves. `runtime-tenants` (protocol 4 clients require it) and `admin-status`
 * (protocol 5 to 7 clients require it) are still advertised for the compatibility window, so
 * those clients keep reaching the Runtime API; protocol 8 clients require neither. The Admin
 * API itself is gone (protocol 8): `/v1/admin/*` is the opaque 404. `artifacts` (protocol 6 and
 * 7, required by their clients): file artifacts, capability links and message `parts`.
 */
export const HOST_PROTOCOL: ProtocolRange = {
  min: 4,
  max: 8,
  features: ["runtime-tenants", "admin-status", ...PROTOCOL_FEATURES, ...OPTIONAL_HOST_FEATURES],
};
export const DEFINITION_SCHEMA_VERSION = 2;

/**
 * The Tenant a protocol 4 client names on every request. Protocol 5 clients send none: the
 * Host serves one Tenant, and answers a header naming another with the opaque 404.
 */
export const TENANT_HEADER = "Nylorun-Tenant";
export const PROTOCOL_HEADER = "Nylorun-Protocol";
/** The subject an application principal acts for (Host feature `subject-headers`). */
export const SUBJECT_HEADER = "Nylorun-Subject";
/** The space-separated scopes of that subject; required with `Nylorun-Subject`. */
export const SCOPES_HEADER = "Nylorun-Scopes";
/** The session, turn and agent of a call the Runtime makes to an HTTP tool's URL. */
export const SESSION_ID_HEADER = "Nylorun-Session-Id";
export const TURN_ID_HEADER = "Nylorun-Turn-Id";
export const AGENT_ID_HEADER = "Nylorun-Agent-Id";

export const ERROR_CODES = [
  "not_found",
  "protocol_unsupported",
  "host_rejected",
  "origin_rejected",
  "unsupported_media_type",
  "connection_missing",
  "incompatible_host",
  "subject_invalid",
  "scope_required",
  /**
   * A known key on the other API (protocol 8): an application key on the Management API
   * (`/v1/tenant/*`), or a management key on the Runtime API. The message names the key's API.
   */
  "key_role_mismatch",
  "token_expired",
  "limit_exceeded",
  /** A request the Runtime refuses for a reason the message gives. */
  "request_rejected",
  /** A request the Host could not read: headers, body or query. */
  "invalid_request",
  /** A route that acts for a person was called without one (`Nylorun-Subject`). */
  "subject_required",
  /** A token caller's sandbox grants do not reach the sandbox (Host feature `sandboxes`). */
  "sandbox_not_granted",
  /** Another session's turn holds the sandbox: turns are serial per sandbox. */
  "sandbox_busy",
  /** The sandbox is gone, or its kind cannot run on this Runtime. */
  "sandbox_unavailable",
  /** The Tenant's placement keeps this session's harness off the host its sandbox needs. */
  "placement_refused",
  /** A pod sandbox's volume or node is gone: only `POST /v1/sandboxes/{id}/reset` brings it back. */
  "sandbox_lost",
  /** A pod sandbox passed its TTL: a `PUT` with a longer `lifecycle.ttl` revives it. */
  "sandbox_expired",
  /**
   * A trusted issuer's token names a key the Runtime has not seen, and the issuer's JWKS cannot
   * be fetched now (Host feature `trusted-issuers`): retry later. Keys already fetched keep working.
   */
  "issuer_unavailable",
  /**
   * An MCP OAuth connect found no way to identify this installation to the authorization server:
   * it offers no dynamic client registration and no client id was given (F9 C2).
   */
  "oauth_client_required",
  /** An OAuth callback's `state` is unknown, already used or expired: start the connect again. */
  "oauth_state_invalid",
  /** The authorization server (or its discovery) failed or refused an MCP OAuth connect step. */
  "oauth_failed",
  /**
   * A definition names definition files the Runtime does not hold (track R2 M4): upload each
   * with `PUT /v1/files/sha256:<hex>` first. `details.missing` lists their hashes.
   */
  "definition_files_missing",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Crockford Base32 alphabet (lowercase); excludes i, l, o, u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export const TENANT_ID_PATTERN = /^tn_[0-9a-hjkmnp-tv-z]{26}$/;
export const PRINCIPAL_ID_PATTERN = /^pr_[0-9a-hjkmnp-tv-z]{26}$/;
/** A Tenant signing key's id, the `kid` of the tokens it signs (capability links, run tokens). */
export const SIGNING_KEY_ID_PATTERN = /^sk_[0-9a-hjkmnp-tv-z]{26}$/;
/** A file artifact's id (protocol 6). */
export const ARTIFACT_ID_PATTERN = /^af_[0-9a-hjkmnp-tv-z]{26}$/;
/**
 * An application key's id: an operator key's name, which names its client (e.g. `backend`).
 * `studio` is reserved for the key Studio derives from the admin key.
 */
export const APPLICATION_KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a key reaches (protocol 8). `application`: the Runtime API, for the whole Tenant or for
 * one subject. `management`: the Management API (`/v1/tenant/*`), as itself only. `studio`: the
 * key Studio derives from the admin key, which reaches both.
 */
export const KEY_ROLES = ["application", "management", "studio"] as const;
export type KeyRole = (typeof KEY_ROLES)[number];
/** The management key a Host registers from `NYLORUN_MANAGEMENT_KEY_FILE` at start. */
export const BOOTSTRAP_KEY_ID = "bootstrap";

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

export function isPrincipalId(value: unknown): value is string {
  return typeof value === "string" && PRINCIPAL_ID_PATTERN.test(value);
}

function encodeTime(ms: number): string {
  let value = Math.floor(ms);
  if (!Number.isFinite(value) || value < 0) value = 0;
  // ULID time component is 48 bits.
  value = value % 2 ** 48;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  // 80 bits → 16 Crockford chars (5 bits each).
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31]!;
    }
  }
  return out;
}

let lastTime = -1;
let lastRandom = "";

function newPrefixedId(
  prefix: "tn_" | "pr_" | "sk_" | "af_",
  now?: number,
): string {
  const ms = now ?? Date.now();
  const time = encodeTime(ms);
  let random = encodeRandom();
  if (ms === lastTime && lastRandom !== "" && random <= lastRandom) {
    random = incrementCrockford(lastRandom);
  }
  lastTime = ms;
  lastRandom = random;
  return `${prefix}${time}${random}`;
}

/**
 * Lowercase Crockford ULID with `tn_` prefix; 48-bit time + 80-bit CSPRNG.
 * Same-millisecond calls stay lexicographically monotonic by bumping the random
 * component when the clock does not advance.
 */
export function newTenantId(now?: number): string {
  return newPrefixedId("tn_", now);
}

/** Principal id: `pr_` + lowercase Crockford ULID (same generator as tenants). */
export function newPrincipalId(now?: number): string {
  return newPrefixedId("pr_", now);
}

/** Signing key id: `sk_` + lowercase Crockford ULID (same generator as tenants). */
export function newSigningKeyId(now?: number): string {
  return newPrefixedId("sk_", now);
}

/** Artifact id: `af_` + lowercase Crockford ULID. */
export function newArtifactId(now?: number): string {
  return newPrefixedId("af_", now);
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}

type SemVerParts = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
};

function parseSemVer(version: string): SemVerParts | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const aValue = BigInt(a);
    const bValue = BigInt(b);
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
    return 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * SemVer 2.0 precedence, including prereleases. Build metadata is ignored.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (left.major !== right.major)
    return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor)
    return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch)
    return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const limit = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < limit; i++) {
    const aId = left.prerelease[i];
    const bId = right.prerelease[i];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const order = compareIdentifiers(aId, bId);
    if (order !== 0) return order;
  }
  return 0;
}

function incrementCrockford(value: string): string {
  const chars = [...value];
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = CROCKFORD.indexOf(chars[i]!);
    if (index < 0) continue;
    if (index < 31) {
      chars[i] = CROCKFORD[index + 1]!;
      return chars.join("");
    }
    chars[i] = CROCKFORD[0]!;
  }
  return encodeRandom();
}

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: "version"; client: number; host: ProtocolRange }
  | {
      ok: false;
      reason: "feature";
      missing: readonly string[];
      host: ProtocolRange;
    };

export function checkCompatibility(
  client: { version: number; required: readonly string[] },
  host: ProtocolRange,
): Compatibility {
  if (client.version < host.min || client.version > host.max) {
    return { ok: false, reason: "version", client: client.version, host };
  }
  const advertised = new Set(host.features);
  const missing = client.required.filter((feature) => !advertised.has(feature));
  if (missing.length > 0) {
    return { ok: false, reason: "feature", missing, host };
  }
  return { ok: true };
}
