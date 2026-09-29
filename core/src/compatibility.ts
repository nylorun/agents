export { hashManifest } from "./utils/hash.js";

export const PROTOCOL_VERSION = 2;
export const PROTOCOL_FEATURES = [
  "runtime-tenants",
  "admin-status",
  "studio-principal",
] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
/**
 * Host features no client requires: a client that uses one checks the Host's `/health`
 * for it first. `tenant-fixture-model`: `PUT /v1/tenant/config/seed` accepts
 * `fixtureModel: true` (the Tenant's model calls use the Runtime's fixture model).
 * `transcript-events`: the log carries `message.assistant` and `tool.completed`, and
 * tool `action.*` events carry `callId` and `invocationId`. `derived-principals`:
 * `POST /v1/admin/tenants` accepts `derivedPrincipals`. `subject-headers`: an application
 * principal may act for a subject with `Nylorun-Subject` and `Nylorun-Scopes`, and the Runtime
 * enforces the scopes and the subject's ownership of sessions and vaults.
 * `subject-tokens`: `POST /v1/tokens` mints ES256 subject tokens for the roles of the Tenant's
 * access policy, and the Tenant API accepts them as bearers (`/v1/access/**` manages the
 * policy, signing keys and revocations). `browser-access`: publishable keys
 * (`Nylorun-Key`, `/v1/access/publishable-keys`) name the Tenant and an origin allowlist, and
 * browser requests from listed origins reach the Tenant routes with CORS. `ag-ui-endpoint`:
 * the Runtime serves AG-UI at `/v1/ag-ui/agents/:agent` for a person named by a subject token
 * or by subject headers.
 */
export const OPTIONAL_HOST_FEATURES = [
  "tenant-fixture-model",
  "transcript-events",
  "derived-principals",
  "subject-headers",
  "subject-tokens",
  "browser-access",
  "ag-ui-endpoint",
] as const;
export type OptionalHostFeature = (typeof OPTIONAL_HOST_FEATURES)[number];
export interface ProtocolRange {
  min: number;
  max: number;
  features: readonly string[];
}
export const HOST_PROTOCOL: ProtocolRange = {
  min: 2,
  max: 2,
  features: [...PROTOCOL_FEATURES, ...OPTIONAL_HOST_FEATURES],
};
export const DEFINITION_SCHEMA_VERSION = 2;

export const TENANT_HEADER = "Nylorun-Tenant";
export const PROTOCOL_HEADER = "Nylorun-Protocol";
/** The subject an application principal acts for (Host feature `subject-headers`). */
export const SUBJECT_HEADER = "Nylorun-Subject";
/** The space-separated scopes of that subject; required with `Nylorun-Subject`. */
export const SCOPES_HEADER = "Nylorun-Scopes";
/** A publishable key: names the Tenant and the client app (Host feature `browser-access`). */
export const PUBLISHABLE_KEY_HEADER = "Nylorun-Key";

export const ERROR_CODES = [
  "not_found",
  "protocol_unsupported",
  "host_rejected",
  "origin_rejected",
  "unsupported_media_type",
  "tenant_conflict",
  "active_work",
  "connection_missing",
  "incompatible_host",
  "subject_invalid",
  "scope_required",
  "token_expired",
  "limit_exceeded",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Crockford Base32 alphabet (lowercase); excludes i, l, o, u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export const TENANT_ID_PATTERN = /^tn_[0-9a-hjkmnp-tv-z]{26}$/;
export const PRINCIPAL_ID_PATTERN = /^pr_[0-9a-hjkmnp-tv-z]{26}$/;
/** A Tenant signing key's id, the `kid` of the subject tokens it signs. */
export const SIGNING_KEY_ID_PATTERN = /^sk_[0-9a-hjkmnp-tv-z]{26}$/;
/** A publishable key's id (not the key). */
export const PUBLISHABLE_KEY_ID_PATTERN = /^pk_[0-9a-hjkmnp-tv-z]{26}$/;
/** A publishable key: `nr_pub_<tenantId>_<32 Crockford characters>`. */
export const PUBLISHABLE_KEY_PATTERN =
  /^nr_pub_(tn_[0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{32})$/;

/** The Tenant a publishable key names, or undefined when it is not one. */
export function tenantOfPublishableKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return PUBLISHABLE_KEY_PATTERN.exec(value)?.[1];
}
/** A derived principal's id names its client, e.g. `babai`; `studio` is reserved. */
export const DERIVED_PRINCIPAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

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
  prefix: "tn_" | "pr_" | "sk_" | "pk_",
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

/** Publishable key id: `pk_` + lowercase Crockford ULID. */
export function newPublishableKeyId(now?: number): string {
  return newPrefixedId("pk_", now);
}

/** A new publishable key for `tenantId`: 160 random bits after the Tenant id. */
export function newPublishableKey(tenantId: string): string {
  if (!isTenantId(tenantId)) throw new Error(`Invalid Tenant id ${tenantId}`);
  let random = "";
  while (random.length < 32) random += encodeRandom();
  return `nr_pub_${tenantId}_${random.slice(0, 32)}`;
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
