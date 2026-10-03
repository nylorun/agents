/**
 * Run tokens (F5, `tenant/run-token.ts`): what core mints for an advance's lease, and what the
 * gateway accepts as one. Everything else is refused: another family's token, another Tenant's
 * or audience's, an expired one, one signed by a revoked key, an oversized one, and a header
 * that could name another key. The live check follows the session's lease.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  DELIVERY_TOKEN_TYPE,
  SUBJECT_TOKEN_AUDIENCE,
  SUBJECT_TOKEN_TYPE,
  subjectTokenIssuer,
} from "@nylorun/core/contracts";
import {
  RUN_TOKEN_AUD,
  RUN_TOKEN_TTL_SECONDS,
  RUN_TOKEN_TYP,
  mintRunToken,
  staleRun,
  verifyRunToken,
} from "../../src/tenant/run-token.js";
import { createRunGrants, renewRunGrant } from "../../src/tenant/run-grants.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

let runs: RunFixture;
beforeAll(async () => {
  runs = await runFixture();
});

const verify = (raw: string) => verifyRunToken(runs.store, runs.tenantId, raw);

/** Signs `claims` over a valid run token's, with the Tenant's key, as `typ`. */
async function signed(overrides: Record<string, unknown> = {}, typ = RUN_TOKEN_TYP): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const { token } = await runs.keys.sign({
    typ,
    claims: {
      iss: subjectTokenIssuer(runs.tenantId),
      aud: RUN_TOKEN_AUD,
      sub: "session-x",
      trn: "turn-1",
      agt: "bot",
      epc: 1,
      iat,
      exp: iat + 60,
      jti: "j",
      ...overrides,
    },
  });
  return token;
}

describe("run tokens", () => {
  it("round-trips: the claims name the lease's session, turn, root agent and epoch", async () => {
    const grant = await runs.run("rt-session", { agentId: "bot", turnId: "turn-7" });
    expect(decodeProtectedHeader(grant.token)).toMatchObject({ alg: "ES256", typ: RUN_TOKEN_TYP });
    expect(Buffer.byteLength(grant.token)).toBeLessThan(1024);
    expect(grant.claims.expiresAt - Date.now()).toBeGreaterThan((RUN_TOKEN_TTL_SECONDS - 5) * 1000);
    expect(await verify(grant.token)).toEqual({
      ok: true,
      claims: {
        tenantId: runs.tenantId,
        sessionId: "rt-session",
        turnId: "turn-7",
        agentId: "bot",
        epoch: grant.claims.epoch,
        expiresAt: grant.claims.expiresAt,
      },
    });
  });

  it("refuses a wrong typ, aud or iss", async () => {
    expect(await verify(await signed({}, "JWT"))).toEqual({ ok: false, reason: "run_token_header" });
    expect(await verify(await signed({ aud: "nylorun" }))).toEqual({ ok: false, reason: "run_token_invalid" });
    expect(await verify(await signed({ iss: subjectTokenIssuer(newTenantId()) }))).toEqual({
      ok: false,
      reason: "run_token_invalid",
    });
    // A valid token of this Tenant, checked as another Tenant's.
    expect(await verifyRunToken(runs.store, newTenantId(), await signed())).toMatchObject({ ok: false });
  });

  it("refuses a subject or delivery token presented as a run token", async () => {
    const subject = await signed({ aud: SUBJECT_TOKEN_AUDIENCE, tnt: runs.tenantId, role: "user", scp: "", epc: 0 }, SUBJECT_TOKEN_TYPE);
    const delivery = await signed({ aud: "http://endpoint.invalid", gen: 1, bdy: "x" }, DELIVERY_TOKEN_TYPE);
    for (const token of [subject, delivery])
      expect(await verify(token)).toEqual({ ok: false, reason: "run_token_header" });
  });

  it("refuses missing or malformed claims and an overlong lifetime", async () => {
    const iat = Math.floor(Date.now() / 1000);
    for (const claims of [
      { trn: undefined },
      { agt: 7 },
      { epc: 0 },
      { epc: 1.5 },
      { sub: "" },
      { exp: iat + RUN_TOKEN_TTL_SECONDS * 2 },
    ])
      expect(await verify(await signed(claims))).toEqual({ ok: false, reason: "run_token_claims" });
  });

  it("accepts an expiry within the 30 s tolerance, and refuses one past it", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await signed({ iat: now - 120, exp: now - 20 }))).toMatchObject({ ok: true });
    expect(await verify(await signed({ iat: now - 120, exp: now - 40 }))).toEqual({
      ok: false,
      reason: "run_token_expired",
    });
  });

  it("refuses a token over 4 KiB and a header that could name another key", async () => {
    expect(await verify(await signed({ pad: "x".repeat(4096) }))).toEqual({
      ok: false,
      reason: "run_token_malformed",
    });
    const [header, payload, signature] = (await signed()).split(".");
    for (const extra of [{ jku: "https://evil.invalid/jwks" }, { jwk: {} }, { x5u: "https://evil.invalid" }, { crit: ["exp"] }]) {
      const forged = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(header!, "base64url").toString()), ...extra }),
      ).toString("base64url");
      expect(await verify(`${forged}.${payload}.${signature}`)).toEqual({ ok: false, reason: "run_token_header" });
    }
    expect(await verify(`${header}.${payload}.${"A".repeat(86)}`)).toEqual({ ok: false, reason: "run_token_invalid" });
    expect(await verify("not-a-token")).toEqual({ ok: false, reason: "run_token_malformed" });
  });

  it("refuses a token whose key was revoked, and verifies under a rotated key at once", async () => {
    const before = await signed();
    expect(await verify(before)).toMatchObject({ ok: true });
    // current → previous → revoked.
    await runs.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    expect(await verify(before)).toMatchObject({ ok: true });
    expect(await verify(await signed())).toMatchObject({ ok: true });
    await runs.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    expect(await verify(before)).toEqual({ ok: false, reason: "run_token_key_revoked" });
  });

  it("is live while the lease, the turn and the status are the token's", async () => {
    const grant = await runs.run("live-1");
    expect(await staleRun(runs.store, grant.claims)).toBeUndefined();
    await runs.update("live-1", { activeTurnId: "turn-2" });
    expect(await staleRun(runs.store, grant.claims)).toMatch(/turn/);
    await runs.update("live-1", { activeTurnId: "turn-1", status: "cancelled" });
    expect(await staleRun(runs.store, grant.claims)).toMatch(/cancelled/);
    await runs.update("live-1", { status: "running" });
    const owner = await runs.takeOver("live-1");
    expect(await staleRun(runs.store, grant.claims)).toMatch(/another advance/);
    expect(await staleRun(runs.store, owner.claims)).toBeUndefined();
    expect(await staleRun(runs.store, { ...owner.claims, sessionId: "gone" })).toMatch(/gone/);
  });

  it("refuses to mint for a session with no active turn", async () => {
    await expect(
      mintRunToken(
        { keys: runs.keys, config: { tenantId: runs.tenantId } },
        { sessionId: "s", owner: "w", epoch: 1 },
        { agentId: "bot", activeTurnId: null },
      ),
    ).rejects.toThrow(/no active turn/);
  });
});

describe("run grants", () => {
  it("keeps a newer advance's grant over an older one's, and drops only its own", async () => {
    const grants = createRunGrants();
    const older = await runs.run("grants-1");
    const newer = await runs.takeOver("grants-1");
    grants.set(newer);
    grants.set(older);
    expect(grants.token("grants-1")).toBe(newer.token);
    grants.drop("grants-1", older.claims.epoch);
    expect(grants.token("grants-1")).toBe(newer.token);
    grants.drop("grants-1", newer.claims.epoch);
    expect(grants.token("grants-1")).toBeUndefined();
  });

  it("re-mints a grant only when less than five minutes remain", async () => {
    const grants = createRunGrants();
    const grant = await runs.run("grants-2");
    const lease = { sessionId: "grants-2", owner: "test-worker", epoch: grant.claims.epoch };
    const ctx = { keys: runs.keys, config: { tenantId: runs.tenantId }, runGrants: grants } as never;
    grants.set(grant);
    await renewRunGrant(ctx, lease);
    expect(grants.get("grants-2")).toBe(grant);
    grants.set({ ...grant, claims: { ...grant.claims, expiresAt: Date.now() + 60_000 } });
    await renewRunGrant(ctx, lease);
    const renewed = grants.get("grants-2")!;
    expect(renewed.token).not.toBe(grant.token);
    expect(renewed.claims).toMatchObject({ sessionId: "grants-2", turnId: "turn-1", epoch: grant.claims.epoch });
    expect(await verify(renewed.token)).toMatchObject({ ok: true });
  });
});
