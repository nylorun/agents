/**
 * Delivery tokens (design: Action endpoints §8.1): minted by the Runtime for one delivery of one
 * Action, accepted back as a bearer only where a route lists them: that Action's heartbeat, result
 * and sandbox callbacks (`delivery-background.test.ts`). Every other route refuses them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  DELIVERY_TOKEN_MAX_TTL_SECONDS,
  DELIVERY_TOKEN_TYPE,
  subjectTokenIssuer,
} from "@nylorun/core/contracts";
import type { TenantContext } from "../../src/tenant/context.js";
import {
  bodyHash,
  mintDeliveryToken,
  verifyDeliveryToken,
} from "../../src/tenant/delivery-token.js";
import { HttpError, OpaqueAuthError } from "../../src/tenant/http.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
});

async function tenant() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });
  live.push(runtime);
  const { ctx } = runtime.handle as unknown as { ctx: TenantContext };
  return { runtime, ctx };
}

const forAction = { kind: "action", actionId: "a1", agentId: "support", generation: 2 } as const;

async function mint(ctx: TenantContext, overrides: Partial<Parameters<typeof mintDeliveryToken>[1]> = {}) {
  return mintDeliveryToken(ctx, {
    for: forAction,
    audience: "http://localhost:3000/actions",
    body: '{"type":"action"}',
    ttlSeconds: 120,
    ...overrides,
  });
}

/** The status and code a rejected verification throws. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, code: error.rejection.code };
    if (error instanceof OpaqueAuthError) return { status: 404, code: "not_found" };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("minting and verifying", () => {
  it("round-trips one delivery of one Action", async () => {
    const { ctx } = await tenant();
    const minted = await mint(ctx);
    const scope = await verifyDeliveryToken(ctx, minted.token);
    expect(scope).toEqual({
      kind: "delivery",
      actionId: "a1",
      agentId: "support",
      generation: 2,
      expiresAt: minted.expiresAt,
      tokenId: minted.tokenId,
      keyId: minted.keyId,
    });
    const [, payload] = minted.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: subjectTokenIssuer(ctx.config.tenantId),
      aud: "http://localhost:3000/actions",
      sub: "a1",
      agt: "support",
      gen: 2,
      bdy: bodyHash('{"type":"action"}'),
    });
    expect(claims.exp - claims.iat).toBe(120);
  });

  it("caps the lifetime at the subject-token maximum", async () => {
    const { ctx } = await tenant();
    const minted = await mint(ctx, { ttlSeconds: 86_400 });
    expect(minted.expiresAt - Date.now()).toBeLessThanOrEqual(DELIVERY_TOKEN_MAX_TTL_SECONDS * 1000);
  });

  it("refuses a ping token, a tampered token and a forged one with the opaque 404", async () => {
    const { ctx } = await tenant();
    const ping = await mint(ctx, { for: { kind: "ping", agentId: "support" } });
    expect(await refusal(verifyDeliveryToken(ctx, ping.token))).toEqual({ status: 404, code: "not_found" });
    const { token } = await mint(ctx);
    const [h, p, s] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), gen: 3 }),
    ).toString("base64url");
    expect(await refusal(verifyDeliveryToken(ctx, `${h}.${other}.${s}`))).toEqual({
      status: 404,
      code: "not_found",
    });
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const forged = await new SignJWT({ agt: "support", gen: 2, bdy: "x" })
      .setProtectedHeader({ alg: "ES256", typ: DELIVERY_TOKEN_TYPE, kid: JSON.parse(Buffer.from(h!, "base64url").toString()).kid })
      .setIssuer(subjectTokenIssuer(ctx.config.tenantId))
      .setAudience("x")
      .setSubject("a1")
      .setIssuedAt()
      .setExpirationTime("1m")
      .setJti("j")
      .sign(privateKey);
    expect(await refusal(verifyDeliveryToken(ctx, forged))).toEqual({ status: 404, code: "not_found" });
  });

  it("answers 401 token_expired for an expired token and a revoked key", async () => {
    const { ctx } = await tenant();
    // Signed and rotated through the keys seam: in process, or the gateway's keys service,
    // which alone holds the vault key with `NYLORUN_TEST_MODEL_GATE=http`.
    const now = Math.floor(Date.now() / 1000);
    const { token: stale } = await ctx.keys.sign({
      typ: DELIVERY_TOKEN_TYPE,
      claims: {
        iss: subjectTokenIssuer(ctx.config.tenantId),
        aud: "x",
        sub: "a1",
        agt: "support",
        gen: 1,
        bdy: "x",
        iat: now - 600,
        exp: now - 120,
        jti: "j",
      },
    });
    expect(await refusal(verifyDeliveryToken(ctx, stale))).toEqual({ status: 401, code: "token_expired" });

    const live = await mint(ctx);
    await ctx.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    await ctx.store.tx((t) => ctx.signingKeys.revoke(t, live.keyId));
    expect(await refusal(verifyDeliveryToken(ctx, live.token))).toEqual({ status: 401, code: "token_expired" });
  });
});

describe("as a bearer", () => {
  const call = (url: string, method: string, path: string, token: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers } });

  it("reaches no route that does not list it (only an Action's callbacks do)", async () => {
    const { runtime, ctx } = await tenant();
    const { token } = await mint(ctx);
    for (const [method, path] of [
      ["GET", "/v1/agents"],
      ["GET", "/v1/sessions"],
      ["GET", "/v1/endpoints"],
      ["POST", "/v1/sessions/s1/commands"],
      ["GET", "/v1/vaults"],
      ["GET", "/v1/tenant"],
    ]) {
      const response = await call(runtime.url, method!, path!, token);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json(), `${method} ${path}`).toMatchObject({
        message: "A delivery token reaches only its Action's callbacks",
      });
    }
  });

  it("is refused from a browser and cannot act for a subject", async () => {
    const { runtime, ctx } = await tenant();
    const { token } = await mint(ctx);
    const browser = await call(runtime.url, "POST", "/v1/actions/a1/heartbeat", token, {
      origin: "https://app.example",
    });
    expect(browser.status).toBe(403);
    expect(await browser.json()).toMatchObject({ code: "origin_rejected" });
    const subject = await call(runtime.url, "POST", "/v1/actions/a1/heartbeat", token, {
      "nylorun-subject": "user-1",
      "nylorun-scopes": "sessions:own",
    });
    expect(subject.status).toBe(403);
    expect(await subject.json()).toMatchObject({ message: "A delivery token cannot act for a subject" });
  });

  it("leaves application keys as they were, and the executor routes are gone", async () => {
    const { runtime } = await tenant();
    expect((await call(runtime.url, "GET", "/v1/agents", APP)).status).toBe(200);
    expect((await call(runtime.url, "GET", "/v1/endpoints", APP)).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/v1/executors"],
      ["GET", "/v1/actions"],
      ["POST", "/v1/actions/a1/claim"],
    ])
      expect((await call(runtime.url, method!, path!, APP)).status, `${method} ${path}`).toBe(404);
  });
});

describe("signing key rotation", () => {
  it("waits for the longest delivery token even when subject tokens live less", async () => {
    const { ctx } = await tenant();
    await ctx.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    const refused = await refusal(ctx.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: false }));
    expect(refused.status).toBe(409);
    const details = await ctx.keys
      .rotateSigningKeys({ maxTtlSeconds: 60, force: false })
      .catch((error: HttpError) => error.rejection.details as { retryAfterSeconds: number });
    expect(details.retryAfterSeconds).toBeGreaterThan(DELIVERY_TOKEN_MAX_TTL_SECONDS);
  });
});
