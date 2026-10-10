/**
 * Trusted issuers (Host feature `trusted-issuers`, F9 I2): JWTs from the operator's identity
 * provider, configured in the identity file, verified against an in-test JWKS server or static
 * keys. Covers what verification refuses, the JWKS cache and outage, what an issuer token
 * reaches (its own sessions, its agents, its sandbox grants), browsers, and `GET /v1/me` for
 * every credential.
 */
import { createPublicKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import { Agent } from "@nylorun/core/define";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { parseIdentityFile } from "../../src/tenant/identity-file.js";
import { createTrustedIssuers } from "../../src/tenant/issuers.js";
import { testPool } from "../support/store.js";

const ISS = "https://idp.test/realms/eng";
const STATIC_ISS = "https://static.test";
const ORIGIN = "http://localhost:5173";

interface Signer {
  kid: string;
  alg: "RS256" | "ES256" | "EdDSA";
  privateKey: CryptoKey;
  jwk: JWK;
}

async function signer(kid: string, alg: Signer["alg"]): Promise<Signer> {
  const pair = await generateKeyPair(alg, { extractable: true });
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, use: "sig", alg } };
}

/** The JWKS server: the keys it publishes, whether it is down, and how often it was asked. */
const jwks = { keys: [] as JWK[], down: false, fetches: 0 };
let server: Server;
let runtime: EphemeralRuntime;
let root: string;
let rsa: Signer;
let ec: Signer;
let late: Signer;
let stranger: Signer;
let ed: Signer;
/** Added to the issuers' clock, to step past the one-refetch-a-minute limit. */
let skew = 0;

async function token(
  key: Signer,
  claims: Record<string, unknown> = {},
  options: { iss?: string; aud?: string; iat?: number; exp?: number; kid?: string | null } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = options.iat ?? now;
  return new SignJWT({ sub: "alice", nylorun_scopes: "sessions:own agents:read studio", org: "acme", ...claims })
    .setProtectedHeader({ alg: key.alg, ...(options.kid === null ? {} : { kid: options.kid ?? key.kid }), typ: "JWT" })
    .setIssuer(options.iss ?? ISS)
    .setAudience(options.aud ?? "nylorun")
    .setIssuedAt(iat)
    .setExpirationTime(options.exp ?? iat + 600)
    .sign(key.privateKey);
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  bearer: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body, headers: response.headers };
}

const app = (method: string, path: string, body?: unknown) =>
  call(method, path, runtime.applicationKey, body === undefined ? {} : { body });

beforeAll(async () => {
  rsa = await signer("rsa-1", "RS256");
  ec = await signer("ec-1", "ES256");
  late = await signer("rsa-2", "RS256");
  stranger = await signer("rsa-x", "RS256");
  ed = await signer("ed-1", "EdDSA");
  jwks.keys = [rsa.jwk, ec.jwk];
  server = createServer((request, response) => {
    jwks.fetches += 1;
    if (jwks.down || request.url !== "/certs") {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: jwks.keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const edPem = createPublicKey({ key: ed.jwk as never, format: "jwk" })
    .export({ type: "spki", format: "pem" })
    .toString();
  const file = `
issuers:
  - name: idp
    issuer: ${ISS}
    audience: nylorun
    jwks: http://127.0.0.1:${port}/certs
    subject: "u:{sub}"
    scopes: { claim: nylorun_scopes }
    allowedScopes: [agents:read, sessions:own, sandboxes:write, studio]
    agents: [bot]
    sandboxes: ["{org}/*", "shared"]
  - name: fixed
    issuer: ${STATIC_ISS}
    audience: api
    keys:
      - |
${edPem
  .trim()
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
    subject: "s:{email}"
    scopes: { fixed: [sessions:own] }
    allowedScopes: [sessions:own]
`;
  root = await mkdtemp(join(tmpdir(), "nylorun-issuers-"));
  runtime = await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    issuers: createTrustedIssuers(parseIdentityFile(file, "identity.yaml"), {
      now: () => Date.now() + skew,
    }),
  });
  for (const id of ["bot", "other"]) {
    const agent = Agent({ id, name: id }).build();
    const saved = await app("PUT", `/v1/agents/${id}`, {
      requestId: `save-${id}`,
      manifest: agent.manifest,
      implementationVersion: "dev",
    });
    expect(saved.status).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

/** The 401 an unknown credential gets: every refused issuer token must look the same. */
async function invalid(): Promise<unknown> {
  return (await call("GET", "/v1/me", "not-a-key-at-all")).body;
}

describe("verification", () => {
  it("accepts an RS256 token and reports what it renders to", async () => {
    const reply = await call("GET", "/v1/me", await token(rsa));
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toEqual({
      subject: "u:alice",
      scopes: ["agents:read", "sessions:own", "studio"],
      agents: ["bot"],
      sandboxes: ["acme/*", "shared"],
      via: "issuer:idp",
    });
  });

  it("accepts an ES256 token, and an EdDSA token from static keys", async () => {
    expect((await call("GET", "/v1/me", await token(ec))).body.subject).toBe("u:alice");
    const fixed = await call(
      "GET",
      "/v1/me",
      await token(ed, { email: "pat@acme.dev" }, {
        iss: STATIC_ISS,
        aud: "api",
        kid: null,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toEqual({
      subject: "s:pat@acme.dev",
      scopes: ["sessions:own"],
      agents: "*",
      sandboxes: [],
      via: "issuer:fixed",
    });
  });

  it("keeps only the allowed scopes, and accepts a claim that is an array", async () => {
    const reply = await call(
      "GET",
      "/v1/me",
      await token(rsa, { nylorun_scopes: ["sessions:own", "agents:write", "tenant:settings", "bogus"] }),
    );
    expect(reply.body.scopes).toEqual(["sessions:own"]);
  });

  it("refuses a wrong audience and a wrong issuer key with 401 credential_invalid", async () => {
    const expected = await invalid();
    expect(expected).toMatchObject({ code: "credential_invalid" });
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      await token(rsa, {}, { aud: "someone-else" }),
      // The static issuer's claims, signed by a key of the JWKS issuer.
      await token(rsa, { email: "pat@acme.dev" }, { iss: STATIC_ISS, aud: "api" }),
      // No subject claim to render.
      await token(rsa, { sub: undefined }),
      // An issued-at in the future.
      await token(rsa, {}, { iat: now + 300, exp: now + 600 }),
    ]) {
      const reply = await call("GET", "/v1/me", bad);
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual(expected);
    }
  });

  it("leaves a token's lifetime to its issuer (protocol 9)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = await token(rsa, {}, { iat: now, exp: now + 24 * 60 * 60 });
    expect((await call("GET", "/v1/me", day)).status).toBe(200);
  });

  it("answers an expired token 401 token_expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const reply = await call("GET", "/v1/me", await token(rsa, {}, { iat: now - 900, exp: now - 60 }));
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("token_expired");
  });

  it("leaves a token of an unknown issuer to the existing checks: 401 credential_invalid", async () => {
    const reply = await call("GET", "/v1/me", await token(rsa, {}, { iss: "https://elsewhere.test" }));
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(await invalid());
  });

  it("refuses an unknown kid, fetching the JWKS at most once a minute for it", async () => {
    await call("GET", "/v1/me", await token(rsa)); // the keys are cached
    const before = jwks.fetches;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await call("GET", "/v1/me", await token(stranger));
      expect(reply.status).toBe(401);
    }
    expect(jwks.fetches - before).toBeLessThanOrEqual(1);
  });

  it("accepts a 6 KiB token and refuses one over 16 KiB", async () => {
    const big = await token(rsa, { padding: "x".repeat(6 * 1024) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(6 * 1024);
    expect((await call("GET", "/v1/me", big)).status).toBe(200);
    // Node's 16 KiB header limit (431) may answer before the 16 KiB token cap (401).
    const huge = await token(rsa, { padding: "x".repeat(17 * 1024) });
    expect([401, 431]).toContain((await call("GET", "/v1/me", huge)).status);
  });

  it("is refused with subject headers", async () => {
    const reply = await call("GET", "/v1/me", await token(rsa), {
      headers: { [SUBJECT_HEADER]: "u:bob", [SCOPES_HEADER]: "sessions:own" },
    });
    expect(reply.status).toBe(403);
  });
});

describe("JWKS outage", () => {
  it("keeps cached keys working and answers a new kid 401 issuer_unavailable", async () => {
    expect((await call("GET", "/v1/me", await token(rsa))).status).toBe(200);
    jwks.down = true;
    jwks.keys = [rsa.jwk, ec.jwk, late.jwk];
    skew += 61_000;
    try {
      expect((await call("GET", "/v1/me", await token(rsa))).status).toBe(200);
      const refused = await call("GET", "/v1/me", await token(late));
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe("issuer_unavailable");
    } finally {
      jwks.down = false;
    }
    // Back up: the next refetch, a minute later, finds the new key.
    skew += 61_000;
    expect((await call("GET", "/v1/me", await token(late))).status).toBe(200);
  });
});

describe("what an issuer token reaches", () => {
  const as = async (sub: string, claims: Record<string, unknown> = {}) => token(rsa, { sub, ...claims });

  it("sees only its own sessions", async () => {
    const alice = await as("alice");
    const created = await call("PUT", "/v1/sessions/alice-1", alice, {
      body: { requestId: "alice-1", agentId: "bot", ownerUserId: "u:alice" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await app("GET", "/v1/sessions/alice-1")).body.ownerUserId).toBe("u:alice");
    const bob = await as("bob");
    expect((await call("GET", "/v1/sessions/alice-1", bob)).status).toBe(404);
    const listed = await call("GET", "/v1/sessions", bob);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toEqual([]);
    expect((await call("GET", "/v1/sessions/alice-1", alice)).status).toBe(200);
  });

  it("reaches only the issuer's agents", async () => {
    const alice = await as("alice");
    const agents = await call("GET", "/v1/agents", alice);
    expect(agents.status).toBe(200);
    expect(agents.body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(["bot"]);
    const refused = await call("PUT", "/v1/sessions/alice-other", alice, {
      body: { requestId: "alice-other", agentId: "other", ownerUserId: "u:alice" },
    });
    expect([403, 404]).toContain(refused.status);
  });

  it("reaches only the sandboxes its rendered grants name", async () => {
    for (const id of ["acme/box", "globex/box", "shared"])
      expect((await app("PUT", `/v1/sandboxes/${encodeURIComponent(id)}`, {})).status).toBe(200);
    const alice = await as("alice");
    expect((await call("GET", `/v1/sandboxes/${encodeURIComponent("acme/box")}`, alice)).status).toBe(200);
    expect((await call("GET", `/v1/sandboxes/${encodeURIComponent("globex/box")}`, alice)).status).toBe(404);
    const listed = await call("GET", "/v1/sandboxes", alice);
    expect(listed.body.sandboxes.map((item: { id: string }) => item.id).sort()).toEqual(["acme/box", "shared"]);
    // A claim that is not one id segment renders no grant: it never widens the template.
    const sneaky = await as("mallory", { org: "globex/box/.." });
    expect((await call("GET", "/v1/me", sneaky)).body.sandboxes).toEqual(["shared"]);
  });

  it("is accepted from a browser, with no toggle (protocol 7)", async () => {
    const reply = await call("GET", "/v1/me", await as("alice"), { headers: { origin: ORIGIN } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.via).toBe("issuer:idp");
    // CORS comes from the operator's proxy, not the Runtime.
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
    // An application key from a browser is still refused.
    const key = await call("GET", "/v1/me", runtime.applicationKey, { headers: { origin: ORIGIN } });
    expect(key.status).toBe(403);
    expect(key.body.code).toBe("origin_rejected");
  });
});

describe("GET /v1/me", () => {
  it("reports an application key, alone and acting for a subject", async () => {
    const alone = await app("GET", "/v1/me");
    expect(alone.status).toBe(200);
    expect(alone.body).toMatchObject({ agents: "*", via: `application:${runtime.principalId}` });
    expect(alone.body.subject).toBeUndefined();
    expect(alone.body.sandboxes).toBeUndefined();
    const acting = await call("GET", "/v1/me", runtime.applicationKey, {
      headers: { [SUBJECT_HEADER]: "u:carol", [SCOPES_HEADER]: "sessions:own agents:read" },
    });
    expect(acting.body).toEqual({
      subject: "u:carol",
      scopes: ["agents:read", "sessions:own"],
      agents: "*",
      via: "subject",
    });
  });

  it("refuses a JWT no issuer of the identity file signed: subject tokens are gone (protocol 7)", async () => {
    const reply = await call("GET", "/v1/me", await token(stranger, {}, { iss: "urn:nylorun:tenant:tn_x" }));
    expect(reply.status).toBe(401);
    expect((await app("POST", "/v1/tokens", { requestId: "mint", subject: "app:dan", role: "user" })).status).toBe(404);
  });
});
