/**
 * A trusted issuer for tests (Host feature `trusted-issuers`): an ES256 key pair, the identity
 * file entry that trusts its public key (static `keys`), and `sign`, which mints a token for a
 * subject. The subject template is `{sub}`, so the token's `sub` is the Runtime's subject; its
 * scopes come from the `scp` claim (space-separated), its sandbox grants from the templates the
 * test gives over the claims it signs (`claims`).
 */
import { createPublicKey } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { ISSUER_SCOPES, type IssuerScope } from "@nylorun/core/contracts";
import { parseIdentityFile, type TrustedIssuerConfig } from "../../src/tenant/identity-file.js";

export const TEST_ISSUER = "https://issuer.test";
export const TEST_AUDIENCE = "nylorun";

export interface TestIssuer {
  /** The identity file's issuers (one), for `issuers` on a test Tenant or ephemeral Runtime. */
  readonly configs: readonly TrustedIssuerConfig[];
  /** The identity file's text, for a Host that reads one. */
  readonly file: string;
  /** A token for `subject` with `scopes`; `claims` fill the sandbox templates. */
  sign(
    subject: string,
    scopes: readonly IssuerScope[] | string,
    options?: { claims?: Record<string, string>; ttlSeconds?: number; iat?: number },
  ): Promise<string>;
}

export async function testIssuer(
  options: {
    name?: string;
    /** The `iss` its tokens carry. Default `https://issuer.test`. */
    iss?: string;
    /** The agents its tokens reach; absent reaches all. */
    agents?: readonly string[];
    /** Sandbox grant templates over signed claims, such as `{team}/*`. */
    sandboxes?: readonly string[];
    /** `maxLifetime`, e.g. `15m`. */
    maxLifetime?: string;
  } = {},
): Promise<TestIssuer> {
  const name = options.name ?? "test";
  const iss = options.iss ?? TEST_ISSUER;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const pem = createPublicKey({ key: (await exportJWK(pair.publicKey)) as never, format: "jwk" })
    .export({ type: "spki", format: "pem" })
    .toString();
  const file = `
issuers:
  - name: ${name}
    issuer: ${iss}
    audience: ${TEST_AUDIENCE}
    keys:
      - |
${pem
  .trim()
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
    subject: "{sub}"
    scopes: { claim: scp }
    allowedScopes: [${ISSUER_SCOPES.join(", ")}]
${options.agents ? `    agents: [${options.agents.map((agent) => JSON.stringify(agent)).join(", ")}]\n` : ""}${
    options.sandboxes
      ? `    sandboxes: [${options.sandboxes.map((grant) => JSON.stringify(grant)).join(", ")}]\n`
      : ""
  }    maxLifetime: ${options.maxLifetime ?? "15m"}
`;
  const configs = parseIdentityFile(file, "test identity file");
  const privateKey: CryptoKey = pair.privateKey;
  return {
    configs,
    file,
    async sign(subject, scopes, signOptions = {}) {
      const iat = signOptions.iat ?? Math.floor(Date.now() / 1000);
      return new SignJWT({
        ...signOptions.claims,
        scp: typeof scopes === "string" ? scopes : scopes.join(" "),
      })
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setIssuer(iss)
        .setAudience(TEST_AUDIENCE)
        .setSubject(subject)
        .setIssuedAt(iat)
        .setExpirationTime(iat + (signOptions.ttlSeconds ?? 600))
        .sign(privateKey);
    },
  };
}
