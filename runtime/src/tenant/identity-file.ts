/**
 * The identity file (Host feature `trusted-issuers`, F9 I2): the YAML file
 * `NYLORUN_IDENTITY_FILE` names, listing the issuers whose JWTs the Tenant API accepts as
 * bearers. Read once at boot (`host/main.ts`); a change takes a restart. A malformed file stops
 * the boot with a message naming the issuer and the field. A key the file does not define is
 * ignored with a warning (`maxLifetime`, gone in protocol 9, among them), so an older file
 * still boots.
 *
 * ```yaml
 * issuers:
 *   - name: keycloak
 *     issuer: https://sso.acme.dev/realms/eng
 *     audience: https://agents.acme.dev
 *     jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs  # or keys: [<PEM>]
 *     # Optional, with their defaults:
 *     subject: "{sub}"                           # scalar claims only
 *     scopes: { claim: scope }                   # or { fixed: [sessions:own, agents:read] }
 *     allowedScopes: [agents:read, sessions:own, sandboxes:write]   # add studio to grant it
 *     agents: [support]                          # absent reaches every agent
 *     sandboxes: ["{org_id}/*"]                  # absent reaches no sandbox
 * ```
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  ISSUER_SCOPES,
  isSandboxGrant,
  TOKEN_SANDBOX_GRANTS_MAX,
  TOKEN_SCOPES,
  type IssuerScope,
} from "@nylorun/core/contracts";

/** The JWT algorithms an issuer may sign with. */
export const ISSUER_ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;
export type IssuerAlgorithm = (typeof ISSUER_ALGORITHMS)[number];

/** An entry's defaults: the `sub` claim, the RFC 9068 `scope` claim, every token scope but `studio`. */
const DEFAULT_SUBJECT = "{sub}";
const DEFAULT_SCOPES = { claim: "scope" } as const;
const DEFAULT_ALLOWED_SCOPES: readonly IssuerScope[] = TOKEN_SCOPES;
/** At most this many static `keys` per issuer. */
const MAX_STATIC_KEYS = 16;
const ISSUER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A claim reference in a template: `{claim}`, a top-level claim name without braces. */
const CLAIM_REFERENCE = /\{([^{}]+)\}/g;

/** A public key an issuer signs with, and the one algorithm it verifies. */
export interface IssuerKey {
  readonly key: KeyObject;
  readonly alg: IssuerAlgorithm;
  readonly kid?: string;
}

/** One trusted issuer, as the identity file declares it. */
export interface TrustedIssuerConfig {
  /** Its name: `issuer:<name>` in `GET /v1/me` and the token's role. */
  readonly name: string;
  /** The `iss` its tokens carry, exactly. */
  readonly issuer: string;
  /** The `aud` its tokens must carry. */
  readonly audience: string;
  /** Where its public keys are fetched (a JWKS URL); or `keys`. */
  readonly jwks?: string;
  /** Its public keys, given in the file (PEM); or `jwks`. */
  readonly keys?: readonly IssuerKey[];
  /** The subject template, such as `{sub}` (the default): at least one claim reference. */
  readonly subject: string;
  /** Where its tokens' scopes come from: a claim, or a fixed list. */
  readonly scopes: { readonly claim: string } | { readonly fixed: readonly IssuerScope[] };
  /** The scopes its tokens may carry; others are dropped. */
  readonly allowedScopes: readonly IssuerScope[];
  /** The agents its tokens reach; absent reaches all. */
  readonly agents?: readonly string[];
  /** Sandbox grant templates, such as `{org_id}/*`; absent reaches no sandbox. */
  readonly sandboxes?: readonly string[];
}

/** A malformed identity file: the message names the issuer and the field. */
export class IdentityFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityFileError";
  }
}

/** The claim names a template references. */
export function claimReferences(template: string): string[] {
  return [...template.matchAll(CLAIM_REFERENCE)].map((match) => match[1]!);
}

/** `template` with every reference replaced by `value(claim)`; undefined when one has none. */
export function renderTemplate(
  template: string,
  value: (claim: string) => string | undefined,
): string | undefined {
  let missing = false;
  const rendered = template.replace(CLAIM_REFERENCE, (_, claim: string) => {
    const found = value(claim);
    if (found === undefined) missing = true;
    return found ?? "";
  });
  return missing ? undefined : rendered;
}

/** True when every brace in `template` belongs to a `{claim}` reference. */
function bracesBalanced(template: string): boolean {
  return !/[{}]/.test(template.replace(CLAIM_REFERENCE, ""));
}

/** A PEM public key an issuer may sign with, and its algorithm; throws a message otherwise. */
export function issuerKey(key: KeyObject, kid?: string): IssuerKey {
  const details = key.asymmetricKeyDetails ?? {};
  switch (key.asymmetricKeyType) {
    case "rsa":
      if ((details.modulusLength ?? 0) < 2048)
        throw new Error("an RSA key must be at least 2048 bits");
      return { key, alg: "RS256", ...(kid ? { kid } : {}) };
    case "ec":
      if (details.namedCurve !== "prime256v1")
        throw new Error("an EC key must be on P-256 (ES256)");
      return { key, alg: "ES256", ...(kid ? { kid } : {}) };
    case "ed25519":
      return { key, alg: "EdDSA", ...(kid ? { kid } : {}) };
    default:
      throw new Error(
        `a ${key.asymmetricKeyType ?? "secret"} key is not accepted: use RSA (RS256), P-256 (ES256) or Ed25519 (EdDSA)`,
      );
  }
}

const template = (what: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .refine(bracesBalanced, `${what} may use braces only around a claim name, as {sub}`);

const IssuerScopeSchema = z.enum(ISSUER_SCOPES, {
  error: (issue) =>
    `${String(issue.input)} is not a scope an issuer may grant (one of ${ISSUER_SCOPES.join(", ")})`,
});

const IssuerEntrySchema = z
  .object({
    name: z.string().regex(ISSUER_NAME, "must match ^[a-z][a-z0-9-]{0,31}$"),
    issuer: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("urn:nylorun:"), "urn:nylorun: issuers are the Runtime's own"),
    audience: z.string().min(1),
    jwks: z
      .string()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
        } catch {
          return false;
        }
      }, "must be an http(s) URL without credentials")
      .optional(),
    keys: z.array(z.string().min(1)).min(1).max(MAX_STATIC_KEYS).optional(),
    subject: template("subject")
      .refine(
        (value) => claimReferences(value).length > 0,
        "must reference a claim, as {sub}: without one every token is the same person",
      )
      .default(DEFAULT_SUBJECT),
    scopes: z
      .union([
        z.object({ claim: z.string().min(1) }).strict(),
        z.object({ fixed: z.array(IssuerScopeSchema) }).strict(),
      ], { error: "must be { claim: <name> } or { fixed: [<scope>, ...] }" })
      .default(DEFAULT_SCOPES),
    allowedScopes: z.array(IssuerScopeSchema).min(1).default([...DEFAULT_ALLOWED_SCOPES]),
    agents: z.array(z.string().min(1)).optional(),
    sandboxes: z
      .array(
        template("a sandbox grant").refine(
          // A rendered grant must be a grant: checked here with a sample value per claim.
          (value) => isSandboxGrant(renderTemplate(value, () => "x")),
          "must render to a sandbox id or a prefix ending in /*, as {org_id}/*",
        ),
      )
      .max(TOKEN_SANDBOX_GRANTS_MAX)
      .optional(),
  });

const IdentityFileSchema = z.object({ issuers: z.array(z.unknown()) });

/** The keys an entry and the file define; any other is ignored with a warning. */
const ENTRY_KEYS = new Set(Object.keys(IssuerEntrySchema.shape));
const FILE_KEYS = new Set(Object.keys(IdentityFileSchema.shape));

/** The keys of `value`, an object, that `known` does not define. */
function unknownKeys(value: unknown, known: ReadonlySet<string>): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter((key) => !known.has(key))
    : [];
}

export interface ParseIdentityFileOptions {
  /** Told of every key the file has but does not define, which is ignored. */
  readonly warn?: (message: string) => void;
}

function issueText(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("").replace(/^\./, "");
      return `${path || "(entry)"}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * The issuers of an identity file's text. Throws `IdentityFileError` naming the file, the issuer
 * and the field when the file is malformed.
 */
export function parseIdentityFile(
  text: string,
  source = "identity file",
  options: ParseIdentityFileOptions = {},
): TrustedIssuerConfig[] {
  const ignored = (where: string, keys: readonly string[]) => {
    if (keys.length > 0)
      options.warn?.(
        `${source}: ${where}: ignored ${keys.map((key) => `\`${key}\``).join(", ")}, which the identity file does not define`,
      );
  };
  const fail = (message: string): never => {
    throw new IdentityFileError(`${source}: ${message}`);
  };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return fail(`not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = IdentityFileSchema.safeParse(raw ?? {});
  if (!file.success) return fail(issueText(file.error.issues));
  ignored("the file", unknownKeys(raw, FILE_KEYS));
  const issuers: TrustedIssuerConfig[] = [];
  file.data.issuers.forEach((entry, index) => {
    const named =
      entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
        ? (entry as { name: string }).name
        : `#${index + 1}`;
    const where = `issuer ${named}`;
    const parsed = IssuerEntrySchema.safeParse(entry);
    if (!parsed.success) return fail(`${where}: ${issueText(parsed.error.issues)}`);
    ignored(where, unknownKeys(entry, ENTRY_KEYS));
    const value = parsed.data;
    if ((value.jwks === undefined) === (value.keys === undefined))
      return fail(`${where}: jwks or keys: give exactly one of them`);
    if ("fixed" in value.scopes) {
      const outside = value.scopes.fixed.filter((scope) => !value.allowedScopes.includes(scope));
      if (outside.length > 0)
        return fail(`${where}: scopes.fixed: ${outside.join(", ")} not in allowedScopes`);
    }
    const keys = value.keys?.map((pem, keyIndex) => {
      try {
        return issuerKey(createPublicKey(pem));
      } catch (error) {
        return fail(
          `${where}: keys[${keyIndex}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    if (issuers.some((other) => other.name === value.name))
      return fail(`${where}: name: another issuer has this name`);
    if (issuers.some((other) => other.issuer === value.issuer))
      return fail(`${where}: issuer: another issuer has ${value.issuer}`);
    issuers.push({
      name: value.name,
      issuer: value.issuer,
      audience: value.audience,
      ...(value.jwks ? { jwks: value.jwks } : {}),
      ...(keys ? { keys } : {}),
      subject: value.subject,
      scopes: value.scopes,
      allowedScopes: [...new Set(value.allowedScopes)],
      ...(value.agents ? { agents: [...new Set(value.agents)] } : {}),
      ...(value.sandboxes ? { sandboxes: value.sandboxes } : {}),
    });
  });
  return issuers;
}
