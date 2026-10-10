/**
 * The Runtime API as an OAuth 2.1 resource server (protocol 9, `tenant/resource-server.ts`):
 * the protected resource metadata (RFC 9728), the `401` and `403` challenges (OAuth 2.1 §5.3,
 * RFC 6750), the challenge a generic client gets before the protocol check, and the identity
 * file's defaults and ignored keys. A Runtime without trusted issuers has no metadata.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { parseIdentityFile } from "../../src/tenant/identity-file.js";
import { testPool } from "../support/store.js";

const ISS = "https://idp.test/realms/eng";
const AUD = "https://agents.test";
const METADATA = "/.well-known/oauth-protected-resource";

let privateKey: CryptoKey;
let runtime: EphemeralRuntime;
let bare: EphemeralRuntime;
const roots: string[] = [];

async function token(
  claims: Record<string, unknown> = {},
  options: { iat?: number | null; exp?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ sub: "alice", scope: "openid sessions:own agents:read", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setExpirationTime(options.exp ?? now + 600);
  if (options.iat !== null) jwt.setIssuedAt(options.iat ?? now);
  return await jwt.sign(privateKey);
}

interface Reply {
  status: number;
  body: any;
  challenge: string | null;
}

async function call(
  target: EphemeralRuntime,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<Reply> {
  const response = await fetch(`${target.url}${path}`, { method, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body, challenge: response.headers.get("www-authenticate") };
}

const versioned = (bearer?: string) => ({
  [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
});

async function start(identityFile?: string): Promise<EphemeralRuntime> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-rs-"));
  roots.push(root);
  return await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    ...(identityFile ? { issuers: parseIdentityFile(identityFile, "identity.yaml") } : {}),
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  const pem = await exportSPKI(pair.publicKey);
  // The smallest entry: everything else takes its default.
  runtime = await start(`
issuers:
  - name: idp
    issuer: ${ISS}
    audience: ${AUD}
    keys:
      - |
${pem
  .trim()
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`);
  bare = await start();
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await bare?.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("protected resource metadata", () => {
  it("names the trusted issuers and their scopes, with no key, protocol or Origin rule", async () => {
    const reply = await call(runtime, "GET", METADATA, { origin: "http://localhost:5173" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      resource: runtime.url,
      authorization_servers: [ISS],
      scopes_supported: ["agents:read", "sessions:own", "sandboxes:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Nylorun Runtime API",
    });
  });

  it("is not there when the Runtime trusts no issuer", async () => {
    expect((await call(bare, "GET", METADATA, {})).status).toBe(404);
  });
});

describe("challenges", () => {
  const metadata = () => `resource_metadata="${runtime.url}${METADATA}"`;

  it("answers no credential with 401 and the metadata, without an error code", async () => {
    const reply = await call(runtime, "GET", "/v1/sessions", versioned());
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("credential_required");
    expect(reply.challenge).toBe(`Bearer ${metadata()}`);
  });

  it("answers a client that sends neither credential nor protocol with the challenge, not 426", async () => {
    const reply = await call(runtime, "GET", "/v1/sessions", {});
    expect(reply.status).toBe(401);
    expect(reply.challenge).toBe(`Bearer ${metadata()}`);
    // A credential without the protocol is still a Nylorun client on the wrong version.
    expect((await call(runtime, "GET", "/v1/sessions", { authorization: "Bearer x" })).status).toBe(426);
  });

  it("answers an unknown key or a token no issuer signed with invalid_token", async () => {
    for (const bearer of ["not-a-key", "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2V2aWwifQ.c2ln"]) {
      const reply = await call(runtime, "GET", "/v1/me", versioned(bearer));
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({
        status: "rejected",
        code: "credential_invalid",
        message: "The credential is not valid here",
      });
      expect(reply.challenge).toBe(`Bearer error="invalid_token", ${metadata()}`);
    }
  });

  it("answers an expired token with token_expired and the challenge", async () => {
    const now = Math.floor(Date.now() / 1000);
    const reply = await call(runtime, "GET", "/v1/me", versioned(await token({}, { iat: now - 3600, exp: now - 600 })));
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("token_expired");
    expect(reply.challenge).toBe(
      `Bearer error="invalid_token", error_description="The access token expired", ${metadata()}`,
    );
  });

  it("answers a token without the route's scope with insufficient_scope", async () => {
    const reply = await call(runtime, "GET", "/v1/sessions", versioned(await token({ scope: "agents:read" })));
    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe("scope_required");
    expect(reply.challenge).toBe(`Bearer error="insufficient_scope", scope="sessions:own", ${metadata()}`);
  });

  it("challenges on the Management API without pointing at the metadata", async () => {
    const reply = await call(runtime, "GET", "/v1/tenant", versioned());
    expect(reply.status).toBe(401);
    expect(reply.challenge).toBe("Bearer");
  });

  it("gives a Runtime without issuers a bare challenge", async () => {
    const reply = await call(bare, "GET", "/v1/sessions", versioned("not-a-key"));
    expect(reply.status).toBe(401);
    expect(reply.challenge).toBe('Bearer error="invalid_token"');
  });
});

describe("bearer tokens", () => {
  it("takes the Bearer scheme in any case", async () => {
    const reply = await call(runtime, "GET", "/v1/me", {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      authorization: `bearer ${runtime.applicationKey}`,
    });
    expect(reply.status).toBe(200);
  });

  it("leaves a token's lifetime to its issuer, and needs no iat", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const bearer of [await token({}, { exp: now + 86_400 }), await token({}, { iat: null })]) {
      const reply = await call(runtime, "GET", "/v1/me", versioned(bearer));
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      // The defaults: the sub claim, the scope claim, every token scope but studio.
      expect(reply.body).toMatchObject({ subject: "alice", scopes: ["agents:read", "sessions:own"], via: "issuer:idp" });
    }
  });
});

describe("the identity file", () => {
  it("fills in the defaults, and ignores keys it does not define with a warning", () => {
    const warnings: string[] = [];
    const [issuer] = parseIdentityFile(
      `
version: 2
issuers:
  - name: idp
    issuer: ${ISS}
    audience: ${AUD}
    jwks: https://idp.test/certs
    maxLifetime: 15m
    agent: [typo]
`,
      "identity.yaml",
      { warn: (message) => warnings.push(message) },
    );
    expect(issuer).toEqual({
      name: "idp",
      issuer: ISS,
      audience: AUD,
      jwks: "https://idp.test/certs",
      subject: "{sub}",
      scopes: { claim: "scope" },
      allowedScopes: ["agents:read", "sessions:own", "sandboxes:write"],
    });
    expect(warnings).toEqual([
      "identity.yaml: the file: ignored `version`, which the identity file does not define",
      "identity.yaml: issuer idp: ignored `maxLifetime`, `agent`, which the identity file does not define",
    ]);
  });
});
