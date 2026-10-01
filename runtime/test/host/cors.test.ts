/**
 * Browser access (Host feature `browser-access`) through the Host: preflight from the route
 * alone, the Tenant named by the publishable key, the key's origin allowlist, CORS headers
 * only after the key and origin pass, and Tenant keys refused from browsers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";

const ORIGIN = "https://app.example.com";
let root: string;
let offRoot: string;
let rt: EphemeralRuntime;
let off: EphemeralRuntime;
let key: string;
let keyId: string;
let token: string;

function appHeaders(runtime: EphemeralRuntime = rt): Record<string, string> {
  return {
    authorization: `Bearer ${runtime.applicationKey}`,
    "nylorun-tenant": runtime.tenantId,
    "nylorun-protocol": "4",
    "content-type": "application/json",
  };
}

async function app(method: string, path: string, body?: unknown) {
  const response = await fetch(`${rt.url}${path}`, {
    method,
    headers: appHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** A request as a browser page on `origin` would send it. */
function browser(
  method: string,
  path: string,
  options: {
    origin?: string | null;
    bearer?: string | null;
    key?: string | null;
    tenant?: string;
    body?: unknown;
  } = {}
) {
  const headers: Record<string, string> = { "nylorun-protocol": "4" };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.key !== null) headers["nylorun-key"] = options.key ?? key;
  if (options.bearer !== null && (options.bearer ?? token))
    headers.authorization = `Bearer ${options.bearer ?? token}`;
  if (options.tenant) headers["nylorun-tenant"] = options.tenant;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${rt.url}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function preflight(
  path: string,
  method = "GET",
  headers = "authorization, nylorun-key, nylorun-protocol",
  origin = ORIGIN,
  runtime = rt
) {
  return fetch(`${runtime.url}${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-cors-"));
  offRoot = await mkdtemp(join(tmpdir(), "nylorun-cors-off-"));
  rt = await startEphemeralRuntime({
    hostRoot: root,
    browserAccess: true,
    model: { kind: "fixture" },
  });
  off = await startEphemeralRuntime({ hostRoot: offRoot, model: { kind: "fixture" } });
  expect(
    (
      await app("PUT", "/v1/agents/bot", {
        requestId: "bot",
        manifest: Agent({ id: "bot", name: "Bot", description: "Helps" }).build().manifest,
        implementationVersion: "dev",
      })
    ).status
  ).toBe(200);
  await app("PUT", "/v1/access/policy", {
    requestId: "p",
    policy: {
      version: 1,
      roles: { user: { scopes: ["sessions:own", "agents:read"], agents: "*" } },
      anon: { scopes: [], agents: [] },
      tokens: { maxTtlSeconds: 600 },
    },
  });
  const created = await app("POST", "/v1/access/publishable-keys", {
    requestId: "k",
    name: "web",
    origins: [ORIGIN, "http://localhost:*"],
  });
  expect(created.status).toBe(200);
  key = created.body.key;
  keyId = created.body.id;
  expect(key).toMatch(new RegExp(`^nr_pub_${rt.tenantId}_`));
  token = (await app("POST", "/v1/tokens", { requestId: "t", subject: "app:ann", role: "user" }))
    .body.token;
});
afterAll(async () => {
  vi.useRealTimers();
  await rt?.close();
  await off?.close();
  await rm(root, { recursive: true, force: true });
  await rm(offRoot, { recursive: true, force: true });
});

describe("preflight", () => {
  it("allows browser routes from any origin, granting no credentials", async () => {
    const response = await preflight("/v1/sessions/s1/commands", "POST", "authorization, content-type, nylorun-key");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-private-network")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("refuses non-browser routes, other headers, null origins and a Host without browser access", async () => {
    for (const response of [
      await preflight("/v1/tokens", "POST"),
      await preflight("/v1/access/policy", "PUT"),
      await preflight("/v1/endpoints", "GET"),
      await preflight("/v1/tenant", "GET"),
      await preflight("/v1/admin/tenants", "GET"),
      await preflight("/v1/sessions/s1/sandbox/bash", "POST"),
      await preflight("/v1/sessions", "GET", "authorization, x-evil"),
      await preflight("/v1/sessions", "PATCH"),
      await preflight("/v1/sessions", "GET", "authorization", "null"),
      await preflight("/v1/sessions", "GET", "authorization", ORIGIN, off),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("actual requests", () => {
  it("names the Tenant by the key and answers an allowed origin with CORS headers", async () => {
    const response = await browser("GET", "/v1/sessions");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
    // Loopback development origins, by port.
    const local = await browser("GET", "/v1/sessions", { origin: "http://localhost:5173" });
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("gives a disallowed origin the opaque 404 and no CORS headers", async () => {
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "https://app.example.com.evil.example"]) {
      const response = await browser("GET", "/v1/sessions", { origin });
      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("answers an unknown key, a disallowed origin and a bad token with the same body", async () => {
    const unknownKey = `nr_pub_${rt.tenantId}_${"0".repeat(32)}`;
    const bodies = [
      await (await browser("GET", "/v1/sessions", { key: unknownKey })).text(),
      await (await browser("GET", "/v1/sessions", { origin: "https://evil.example" })).text(),
      await (await browser("GET", "/v1/sessions", { bearer: "aaaa.bbbb.cccc" })).text(),
    ];
    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses an Origin without a publishable key", async () => {
    const response = await browser("GET", "/v1/sessions", { key: null, tenant: rt.tenantId });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("origin_rejected");
  });

  it("refuses Tenant keys from browsers before looking them up", async () => {
    const withKey = await browser("GET", "/v1/sessions", { bearer: rt.applicationKey });
    expect(withKey.status).toBe(403);
    expect((await withKey.json()).code).toBe("origin_rejected");
    const unknown = await browser("GET", "/v1/sessions", { bearer: "a".repeat(64) });
    expect(unknown.status).toBe(403);
  });

  it("refuses a Tenant key sent with a publishable key", async () => {
    const response = await browser("GET", "/v1/sessions", {
      origin: null,
      bearer: rt.applicationKey,
    });
    expect(response.status).toBe(400);
  });

  it("checks the key against Nylorun-Tenant and its own shape", async () => {
    const other = "tn_00000000000000000000000009";
    expect((await browser("GET", "/v1/sessions", { tenant: other })).status).toBe(400);
    expect((await browser("GET", "/v1/sessions", { key: "nr_pub_nope" })).status).toBe(400);
  });

  it("refuses Origin on /health, /ready and admin routes", async () => {
    for (const path of ["/health", "/ready", "/v1/admin/status"]) {
      const response = await fetch(`${rt.url}${path}`, { headers: { origin: ORIGIN } });
      expect(response.status, path).toBe(403);
    }
  });

  it("lets a native app send the key without an Origin", async () => {
    const response = await browser("GET", "/v1/sessions", { origin: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("makes an expired token's 401 readable to the page", async () => {
    const short = (
      await app("POST", "/v1/tokens", { requestId: "s", subject: "app:ann", role: "user", ttlSeconds: 60 })
    ).body.token;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    try {
      const response = await browser("GET", "/v1/sessions", { bearer: short });
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(response.headers.get("www-authenticate")).toContain("invalid_token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries CORS headers on event streams", async () => {
    const put = await browser("PUT", "/v1/sessions/ann-1", {
      body: { requestId: "a", agentId: "bot", ownerUserId: "app:ann" },
    });
    expect(put.status).toBe(200);
    const controller = new AbortController();
    const stream = await browser("GET", "/v1/sessions/ann-1/events");
    expect(stream.status).toBe(200);
    expect(stream.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    await stream.body?.cancel();
  });
});

describe("a publishable key alone", () => {
  it("reaches nothing while anon is empty, and only the public agent list otherwise", async () => {
    const agents = await browser("GET", "/v1/agents", { bearer: null });
    expect(agents.status).toBe(403);
    const policy = (await app("GET", "/v1/access/policy")).body.policy;
    await app("PUT", "/v1/access/policy", {
      requestId: "anon",
      policy: { ...policy, anon: { scopes: ["agents:read"], agents: "*" } },
    });
    const listed = await browser("GET", "/v1/agents", { bearer: null });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      agents: [{ agentId: "bot", name: "Bot", description: "Helps" }],
    });
    expect((await browser("GET", "/v1/sessions", { bearer: null })).status).toBe(403);
    await app("PUT", "/v1/access/policy", { requestId: "back", policy });
  });

  it("reads the JWKS", async () => {
    const jwks = await browser("GET", "/v1/access/jwks", { bearer: null });
    expect(jwks.status).toBe(200);
    expect((await jwks.json()).keys.length).toBeGreaterThan(0);
  });
});

describe("managing keys", () => {
  it("updates origins and revokes", async () => {
    const updated = await app("PUT", `/v1/access/publishable-keys/${keyId}`, {
      requestId: "u",
      origins: ["https://other.example.com"],
    });
    expect(updated.body.origins).toEqual(["https://other.example.com"]);
    expect((await browser("GET", "/v1/sessions")).status).toBe(404);
    await app("PUT", `/v1/access/publishable-keys/${keyId}`, {
      requestId: "u2",
      origins: [ORIGIN, "http://localhost:*"],
    });
    expect((await browser("GET", "/v1/sessions")).status).toBe(200);
    const revoked = await app("DELETE", `/v1/access/publishable-keys/${keyId}`);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await browser("GET", "/v1/sessions")).status).toBe(404);
    expect((await browser("GET", "/v1/sessions", { origin: null })).status).toBe(404);
  });

  it("refuses invalid origins and duplicate names", async () => {
    for (const origins of [["https://app.example.com/path"], ["*"], ["https://*.example.com"]])
      expect(
        (await app("POST", "/v1/access/publishable-keys", { requestId: "x", name: "bad", origins })).status
      ).toBe(400);
    expect(
      (await app("POST", "/v1/access/publishable-keys", { requestId: "d", name: "web", origins: [] })).status
    ).toBe(409);
  });

  it("is refused to tokens and publishable keys", async () => {
    const fresh = await app("POST", "/v1/access/publishable-keys", {
      requestId: "f",
      name: "fresh",
      origins: [ORIGIN],
    });
    const response = await browser("GET", "/v1/access/publishable-keys", { key: fresh.body.key });
    expect(response.status).toBe(403);
  });
});
