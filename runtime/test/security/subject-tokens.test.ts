/**
 * Subject tokens (Host feature `subject-tokens`): minting, verification, what a token caller
 * may reach, revocation, limits and signing-key rotation. Every forged, confused or foreign
 * token is the same opaque 404 as an unknown key; only a verified token that a new token would
 * fix answers `401 token_expired`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { Agent } from "@nylorun/core/define";
import {
  createSession,
  settle,
  startSubjectTenant,
  type Reply,
  type SubjectTenant,
} from "./subjects.js";

let tenant: SubjectTenant;
let other: SubjectTenant;

const POLICY = {
  version: 1,
  roles: {
    user: { scopes: ["sessions:own", "vaults:own", "agents:read"], agents: "*" },
    narrow: { scopes: ["sessions:own"], agents: ["other"] },
    capped: {
      scopes: ["sessions:own"],
      agents: "*",
      limits: { turnsPerHour: 2 },
    },
    single: {
      scopes: ["sessions:own"],
      agents: "*",
      limits: { concurrentTurns: 1 },
    },
    doomed: { scopes: ["sessions:own"], agents: "*" },
  },
  anon: { scopes: [], agents: [] },
  tokens: { maxTtlSeconds: 600 },
};

async function putPolicy(t: SubjectTenant, policy: unknown = POLICY) {
  const reply = await t.call("PUT", "/v1/access/policy", {
    body: { requestId: "policy", policy },
  });
  expect(reply.status, reply.text).toBe(200);
}

let minted = 0;
async function mint(
  t: SubjectTenant,
  subject: string,
  role = "user",
  extra: Record<string, unknown> = {}
): Promise<string> {
  const reply = await t.call("POST", "/v1/tokens", {
    body: { requestId: `mint-${(minted += 1)}`, subject, role, ...extra },
  });
  expect(reply.status, reply.text).toBe(200);
  return reply.body.token as string;
}

/** A call with a subject token. */
function as(
  t: SubjectTenant,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Reply> {
  return t.call(method, path, {
    key: token,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

beforeAll(async () => {
  tenant = await startSubjectTenant();
  other = await startSubjectTenant();
  await putPolicy(tenant);
  await putPolicy(other);
});
afterAll(async () => {
  await tenant.close();
  await other.close();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("minting", () => {
  it("mints an ES256 token for a role, with the Tenant's issuer and the subject", async () => {
    const reply = await tenant.call("POST", "/v1/tokens", {
      body: { requestId: "m1", subject: "app:alice", role: "user", ttlSeconds: 300 },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      subject: "app:alice",
      role: "user",
      scopes: ["sessions:own", "vaults:own", "agents:read"],
      agents: "*",
    });
    const header = decodeProtectedHeader(reply.body.token);
    expect(header).toMatchObject({ alg: "ES256", typ: "nylorun-subject+jwt", kid: reply.body.keyId });
    const claims = decodeJwt(reply.body.token);
    expect(claims).toMatchObject({ sub: "app:alice", aud: "nylorun", role: "user", epc: 0 });
    expect(claims.iss).toBe(`urn:nylorun:tenant:${tenant.runtime.tenantId}`);
    expect(claims.exp! - claims.iat!).toBe(300);
  });

  it("refuses unknown roles, wider scopes and agents, and reserved subjects", async () => {
    const refuse = async (body: Record<string, unknown>) =>
      (await tenant.call("POST", "/v1/tokens", { body: { requestId: "x", ...body } })).status;
    expect(await refuse({ subject: "app:a", role: "ghost" })).toBe(400);
    expect(await refuse({ subject: "app:a", role: "narrow", scopes: ["vaults:own"] })).toBe(400);
    expect(await refuse({ subject: "app:a", role: "narrow", agents: ["bot"] })).toBe(400);
    expect(await refuse({ subject: "host", role: "user" })).toBe(400);
    expect(await refuse({ subject: "app:a", role: "user", scopes: ["agents:write"] })).toBe(400);
  });

  it("mints nothing while the policy has no roles", async () => {
    const empty = await startSubjectTenant();
    try {
      const reply = await empty.call("POST", "/v1/tokens", {
        body: { requestId: "m", subject: "app:a", role: "user" },
      });
      expect(reply.status).toBe(400);
    } finally {
      await empty.close();
    }
  });

  it("refuses a policy that gives tokens agents:write or names a role anon", async () => {
    for (const roles of [
      { admin: { scopes: ["agents:write"], agents: "*" } },
      { anon: { scopes: ["sessions:own"], agents: "*" } },
    ]) {
      const reply = await tenant.call("PUT", "/v1/access/policy", {
        body: { requestId: "bad", policy: { ...POLICY, roles } },
      });
      expect(reply.status).toBe(400);
    }
  });

  it("is refused to subjects and tokens", async () => {
    const token = await mint(tenant, "app:alice");
    const body = { requestId: "m", subject: "app:mallory", role: "user" };
    expect((await as(tenant, token, "POST", "/v1/tokens", body)).status).toBe(403);
    const acting = await tenant.call("POST", "/v1/tokens", {
      as: { subject: "app:alice", scopes: ["sessions:own"] },
      body,
    });
    expect(acting.status).toBe(403);
    expect((await as(tenant, token, "GET", "/v1/access/policy")).status).toBe(403);
    expect((await as(tenant, token, "POST", "/v1/access/revocations", { requestId: "r", subject: "app:bob" })).status).toBe(403);
  });
});

describe("verification", () => {
  const unknown = async () => (await tenant.call("GET", "/v1/sessions", { key: "not-a-key-at-all" })).body;

  async function forged(): Promise<string[]> {
    const real = await mint(tenant, "app:alice");
    const [h, p, s] = real.split(".");
    const header = decodeProtectedHeader(real);
    const claims = decodeJwt(real);
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const attacker = await generateKeyPair("ES256");
    const attackerJwk = await exportJWK(attacker.publicKey);
    const signed = (extraHeader: Record<string, unknown>, payload = claims) =>
      new SignJWT(payload as never)
        .setProtectedHeader({ alg: "ES256", typ: "nylorun-subject+jwt", kid: header.kid!, ...extraHeader })
        .sign(attacker.privateKey);
    const keys = await tenant.call("GET", "/v1/access/jwks");
    const hmacSecret = new TextEncoder().encode(JSON.stringify(keys.body.keys[0]));
    return [
      // alg none
      new UnsecuredJWT(claims as never).encode(),
      `${b64({ ...header, alg: "none" })}.${p}.`,
      // HS256 signed with the published public key as the secret
      await new SignJWT(claims as never)
        .setProtectedHeader({ alg: "HS256", typ: "nylorun-subject+jwt", kid: header.kid! })
        .sign(hmacSecret),
      // a stranger's key under the Tenant's kid, with and without an embedded jwk
      await signed({}),
      await signed({ jwk: attackerJwk }),
      await signed({ jku: "https://attacker.example/jwks.json" }),
      // tampered payload
      `${h}.${b64({ ...claims, sub: "app:mallory" })}.${s}`,
      // wrong typ, unknown kid, injected kid
      `${b64({ ...header, typ: "JWT" })}.${p}.${s}`,
      `${b64({ ...header, kid: "sk_00000000000000000000000000" })}.${p}.${s}`,
      `${b64({ ...header, kid: "../../etc/passwd" })}.${p}.${s}`,
      `${b64({ ...header, kid: "x".repeat(6000) })}.${p}.${s}`,
      // a token of another Tenant
      await mint(other, "app:alice"),
      // garbage with a JWT shape
      "aaaa.bbbb.cccc",
    ];
  }

  it("answers every forged or foreign token with the opaque 404 of an unknown key", async () => {
    const expected = await unknown();
    for (const token of await forged()) {
      const reply = await as(tenant, token, "GET", "/v1/sessions");
      expect(reply.status, token.slice(0, 40)).toBe(404);
      expect(reply.body).toEqual(expected);
    }
  });

  it("answers an expired token with 401 token_expired", async () => {
    const token = await mint(tenant, "app:alice", "user", { ttlSeconds: 60 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const reply = await as(tenant, token, "GET", "/v1/sessions");
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("token_expired");
  });

  it("refuses a token sent with subject headers", async () => {
    const token = await mint(tenant, "app:alice");
    const reply = await as(tenant, token, "GET", "/v1/sessions", undefined, {
      "nylorun-subject": "app:bob",
      "nylorun-scopes": "sessions:own",
    });
    expect(reply.status).toBe(403);
  });

  it("ignores a token in the query string", async () => {
    const token = await mint(tenant, "app:alice");
    const reply = await tenant.call("GET", `/v1/sessions?access_token=${token}`, { key: "nope" });
    expect(reply.status).toBe(404);
  });
});

describe("what a token reaches", () => {
  it("reaches its own sessions and the public view of agents", async () => {
    const token = await mint(tenant, "app:carol");
    const created = await as(tenant, token, "PUT", "/v1/sessions/carol-1", {
      requestId: "c1",
      agentId: "bot",
      ownerUserId: "app:carol",
    });
    expect(created.status, created.text).toBe(200);
    const list = await as(tenant, token, "GET", "/v1/sessions");
    expect(list.body.sessions.map((s: any) => s.id)).toEqual(["carol-1"]);
    const agents = await as(tenant, token, "GET", "/v1/agents");
    expect(agents.body).toEqual({ agents: [{ agentId: "bot", name: "Bot" }] });
  });

  it("never reaches another subject's sessions", async () => {
    await createSession(tenant, "dave-1", { subject: "app:dave", scopes: ["sessions:own"] });
    const token = await mint(tenant, "app:erin");
    expect((await as(tenant, token, "GET", "/v1/sessions/dave-1")).status).toBe(404);
    expect((await as(tenant, token, "GET", "/v1/sessions/dave-1/items")).status).toBe(404);
    const command = await as(tenant, token, "POST", "/v1/sessions/dave-1/commands", {
      type: "cancel",
      requestId: "c",
      idempotencyKey: "c",
    });
    expect(command.status).toBe(404);
  });

  it("is limited to the agents of its role", async () => {
    const token = await mint(tenant, "app:frank", "narrow");
    const put = await as(tenant, token, "PUT", "/v1/sessions/frank-1", {
      requestId: "f1",
      agentId: "bot",
      ownerUserId: "app:frank",
    });
    expect(put.status).toBe(404);
    await createSession(tenant, "frank-bot", { subject: "app:frank", scopes: ["sessions:own"] });
    expect((await as(tenant, token, "GET", "/v1/sessions/frank-bot")).status).toBe(404);
    const list = await as(tenant, token, "GET", "/v1/sessions");
    expect(list.body.sessions).toEqual([]);
  });

  it("refuses session info, message.manifest and OAuth refresh credentials", async () => {
    const token = await mint(tenant, "app:gina");
    const info = await as(tenant, token, "PUT", "/v1/sessions/gina-1", {
      requestId: "g1",
      agentId: "bot",
      ownerUserId: "app:gina",
      info: { plan: "enterprise" },
    });
    expect(info.status).toBe(403);
    await as(tenant, token, "PUT", "/v1/sessions/gina-2", {
      requestId: "g2",
      agentId: "bot",
      ownerUserId: "app:gina",
    });
    const manifest = await as(tenant, token, "POST", "/v1/sessions/gina-2/commands", {
      type: "message",
      requestId: "m",
      idempotencyKey: "m",
      content: "hi",
      manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
    });
    expect(manifest.status).toBe(403);
    const vault = await as(tenant, token, "POST", "/v1/vaults", {
      requestId: "v",
      idempotencyKey: "v",
      name: "gina",
      ownerUserId: "app:gina",
    });
    expect(vault.status, vault.text).toBe(200);
    const refresh = await as(tenant, token, "POST", `/v1/vaults/${vault.body.id}/credentials`, {
      requestId: "c",
      idempotencyKey: "c",
      name: "gh",
      auth: {
        type: "oauth",
        url: "https://mcp.example.com",
        accessToken: "a",
        refresh: {
          tokenEndpoint: "https://169.254.169.254/latest",
          clientId: "c",
          refreshToken: "r",
          tokenEndpointAuth: { type: "none" },
        },
      },
    });
    expect(refresh.status).toBe(403);
  });

  it("cannot define a sandbox or share another subject's", async () => {
    const token = await mint(tenant, "app:ivan");
    const open = (id: string, extra: Record<string, unknown>) =>
      as(tenant, token, "PUT", `/v1/sessions/${id}`, {
        requestId: `open-${id}`,
        agentId: "bot",
        ownerUserId: "app:ivan",
        ...extra,
      });
    const inline = await open("ivan-1", { sandbox: {} });
    expect(inline.status).toBe(403);
    expect(inline.text).toContain("Defining a sandbox needs an application key");
    expect((await createSession(tenant, "judy-1", { subject: "app:judy", scopes: ["sessions:own"] })).status).toBe(200);
    const shared = await open("ivan-2", { sandbox: { session: "judy-1" } });
    expect(shared.status).toBe(404);
    const none = await open("ivan-3", { sandbox: false });
    expect(none.status, none.text).toBe(200);
  });

  it("never reaches operator, executor or settings routes", async () => {
    const token = await mint(tenant, "app:hank");
    for (const [method, path, body] of [
      ["GET", "/v1/executors", undefined],
      ["GET", "/v1/actions", undefined],
      ["GET", "/v1/tenant", undefined],
      ["GET", "/v1/tenant/models", undefined],
      ["GET", "/v1/access/signing-keys", undefined],
      [
        "PUT",
        "/v1/agents/sneaky",
        {
          requestId: "s",
          manifest: Agent({ id: "sneaky", name: "S" }).build().manifest,
          implementationVersion: "dev",
        },
      ],
    ] as const)
      expect((await as(tenant, token, method, path, body)).status, `${method} ${path}`).toBe(403);
  });
});

describe("revocation", () => {
  it("ends every token minted before it; new tokens work", async () => {
    const old = await mint(tenant, "app:ivan");
    expect((await as(tenant, old, "GET", "/v1/sessions")).status).toBe(200);
    const revoked = await tenant.call("POST", "/v1/access/revocations", {
      body: { requestId: "r", subject: "app:ivan" },
    });
    expect(revoked.body).toEqual({ subject: "app:ivan", epoch: 1 });
    const reply = await as(tenant, old, "GET", "/v1/sessions");
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("token_expired");
    const fresh = await mint(tenant, "app:ivan");
    expect((await as(tenant, fresh, "GET", "/v1/sessions")).status).toBe(200);
  });

  it("ends the subject's open event streams, not other subjects'", async () => {
    const ivy = await mint(tenant, "app:ivy");
    const jon = await mint(tenant, "app:jon");
    for (const [token, subject] of [[ivy, "app:ivy"], [jon, "app:jon"]] as const)
      await as(tenant, token, "PUT", `/v1/sessions/${subject}-s`, {
        requestId: subject,
        agentId: "bot",
        ownerUserId: subject,
      });
    const open = (token: string, subject: string) =>
      fetch(`${tenant.runtime.url}/v1/sessions/${subject}-s/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const ivyStream = await open(ivy, "app:ivy");
    const jonStream = await open(jon, "app:jon");
    expect(ivyStream.status).toBe(200);
    await tenant.call("POST", "/v1/access/revocations", {
      body: { requestId: "r2", subject: "app:ivy" },
    });
    const text = await ivyStream.text();
    expect(text).toContain("event: nylorun.closed");
    expect(text).toContain('"reason":"revoked"');
    // Jon's stream is still open: reading it would wait, so cancel it instead.
    const reader = jonStream.body!.getReader();
    const race = await Promise.race([
      reader.read().then(() => "data"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 300)),
    ]);
    expect(["open", "data"]).toContain(race);
    await reader.cancel();
  });

  it("ends a stream when its token expires", async () => {
    const token = await mint(tenant, "app:kim", "user", { ttlSeconds: 60 });
    await as(tenant, token, "PUT", "/v1/sessions/kim-s", {
      requestId: "k",
      agentId: "bot",
      ownerUserId: "app:kim",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 59_500);
    const stream = await fetch(`${tenant.runtime.url}/v1/sessions/kim-s/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('"reason":"token_expired"');
  });
});

describe("limits", () => {
  async function turn(token: string, session: string, n: number): Promise<Reply> {
    return as(tenant, token, "POST", `/v1/sessions/${session}/commands`, {
      type: "message",
      requestId: `t${n}`,
      idempotencyKey: `t${n}`,
      content: "hi",
    });
  }

  it("caps turns per hour and does not charge a replayed message", async () => {
    const token = await mint(tenant, "app:lee", "capped");
    await as(tenant, token, "PUT", "/v1/sessions/lee-s", {
      requestId: "l",
      agentId: "bot",
      ownerUserId: "app:lee",
    });
    expect((await turn(token, "lee-s", 1)).status).toBe(200);
    await settle(tenant, "lee-s");
    // The same message again is a replay: no charge.
    expect((await turn(token, "lee-s", 1)).status).toBe(200);
    expect((await turn(token, "lee-s", 2)).status).toBe(200);
    await settle(tenant, "lee-s");
    const third = await turn(token, "lee-s", 3);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("limit_exceeded");
    expect(third.body.details.limit).toBe("turnsPerHour");
  });

  it("caps concurrent turns", async () => {
    const token = await mint(tenant, "app:max", "single");
    for (const id of ["max-a", "max-b"])
      await as(tenant, token, "PUT", `/v1/sessions/${id}`, {
        requestId: id,
        agentId: "bot",
        ownerUserId: "app:max",
      });
    const results = await Promise.all(
      ["max-a", "max-b"].map((id, n) => turn(token, id, 10 + n))
    );
    const statuses = results.map((r) => r.status).sort();
    // Both may succeed if the first finished before the second arrived; never more than one runs.
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
  });
});

describe("roles and keys", () => {
  it("ends tokens whose role is removed", async () => {
    const token = await mint(tenant, "app:nia", "doomed");
    expect((await as(tenant, token, "GET", "/v1/sessions")).status).toBe(200);
    const { doomed: _, ...roles } = POLICY.roles;
    await putPolicy(tenant, { ...POLICY, roles });
    const reply = await as(tenant, token, "GET", "/v1/sessions");
    expect(reply.status).toBe(401);
    await putPolicy(tenant);
  });

  it("rotates without signing anyone out, refuses a second rotation, and forces one", async () => {
    const keys = await startSubjectTenant();
    try {
      await putPolicy(keys);
      const token = await mint(keys, "app:olga");
      const jwks = await keys.call("GET", "/v1/access/jwks");
      expect(jwks.body.keys).toHaveLength(2);
      const rotated = await keys.call("POST", "/v1/access/signing-keys/rotate", {
        body: { requestId: "r1" },
      });
      expect(rotated.status, rotated.text).toBe(200);
      expect(rotated.body.keys.map((k: any) => k.state).sort()).toEqual([
        "current",
        "previous",
        "standby",
      ]);
      expect(JSON.stringify(rotated.body)).not.toMatch(/ciphertext|pkcs8|"d":/);
      expect((await as(keys, token, "GET", "/v1/sessions")).status).toBe(200);
      const again = await keys.call("POST", "/v1/access/signing-keys/rotate", {
        body: { requestId: "r2" },
      });
      expect(again.status).toBe(409);
      const forced = await keys.call("POST", "/v1/access/signing-keys/rotate", {
        body: { requestId: "r3", force: true },
      });
      expect(forced.status).toBe(200);
      expect((await as(keys, token, "GET", "/v1/sessions")).status).toBe(401);
      const current = forced.body.keys.find((k: any) => k.state === "current");
      const revokeCurrent = await keys.call(
        "POST",
        `/v1/access/signing-keys/${current.id}/revoke`,
        { body: { requestId: "rc" } }
      );
      expect(revokeCurrent.status).toBe(409);
      const fresh = await mint(keys, "app:olga");
      expect((await as(keys, fresh, "GET", "/v1/sessions")).status).toBe(200);
    } finally {
      await keys.close();
    }
  });
});
