/**
 * Egress tokens (F7.2, `sandbox/egress-token.ts`): what a pod's harness receives at join and
 * egress-gate accepts as its proxy credential. Everything else is refused: another family's
 * token (run, host, subject, delivery), another Tenant's or audience's, an expired one, one
 * signed by a revoked key, an oversized one, and a header that could name another key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { newTenantId } from "@nylorun/core/compatibility";
import { DELIVERY_TOKEN_TYPE, SUBJECT_TOKEN_AUDIENCE, SUBJECT_TOKEN_TYPE, subjectTokenIssuer } from "@nylorun/core/contracts";
import {
  EGRESS_TOKEN_AUD,
  EGRESS_TOKEN_MAX_TTL_SECONDS,
  EGRESS_TOKEN_TYP,
  mintEgressToken,
  verifyEgressToken,
} from "../../src/sandbox/egress-token.js";
import { RUN_TOKEN_AUD, RUN_TOKEN_TYP } from "../../src/tenant/run-token.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

let runs: RunFixture;
beforeAll(async () => {
  runs = await runFixture();
});

const verify = (raw: string) => verifyEgressToken(runs.store, runs.tenantId, raw);
const mint = (overrides: Partial<Parameters<typeof mintEgressToken>[1]> = {}) =>
  mintEgressToken(
    { keys: runs.keys },
    { tenantId: runs.tenantId, sandboxId: "sbx_1", epoch: 3, podUid: "pod-uid-1", ...overrides },
  );

/** Signs `claims` over a valid egress token's, with the Tenant's key, as `typ`. */
async function signed(overrides: Record<string, unknown> = {}, typ = EGRESS_TOKEN_TYP): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const { token } = await runs.keys.sign({
    typ,
    claims: {
      iss: subjectTokenIssuer(runs.tenantId),
      aud: EGRESS_TOKEN_AUD,
      sbx: "sbx_1",
      epc: 1,
      pod: "pod-uid-1",
      iat,
      exp: iat + 60,
      jti: "j",
      ...overrides,
    },
  });
  return token;
}

describe("egress tokens", () => {
  it("round-trips: the claims name the sandbox, its host epoch and the pod", async () => {
    const grant = await mint();
    expect(decodeProtectedHeader(grant.token)).toMatchObject({ alg: "ES256", typ: EGRESS_TOKEN_TYP });
    expect(Buffer.byteLength(grant.token)).toBeLessThan(1024);
    expect(grant.claims.expiresAt - Date.now()).toBeGreaterThan((EGRESS_TOKEN_MAX_TTL_SECONDS - 5) * 1000);
    expect(await verify(grant.token)).toEqual({
      ok: true,
      claims: {
        tenantId: runs.tenantId,
        sandboxId: "sbx_1",
        epoch: 3,
        podUid: "pod-uid-1",
        expiresAt: grant.claims.expiresAt,
      },
    });
  });

  it("mints only a lifetime up to the maximum, a positive epoch and named sandbox and pod", async () => {
    expect((await mint({ ttl: 60 })).claims.expiresAt - Date.now()).toBeLessThanOrEqual(61_000);
    await expect(mint({ ttl: EGRESS_TOKEN_MAX_TTL_SECONDS + 1 })).rejects.toThrow(/lives/);
    await expect(mint({ ttl: 0 })).rejects.toThrow(/lives/);
    await expect(mint({ epoch: 0 })).rejects.toThrow(/epoch/);
    await expect(mint({ podUid: "" })).rejects.toThrow(/pod/);
  });

  it("refuses a wrong typ, aud or iss", async () => {
    expect(await verify(await signed({}, "JWT"))).toEqual({ ok: false, reason: "egress_token_header" });
    expect(await verify(await signed({ aud: RUN_TOKEN_AUD }))).toEqual({ ok: false, reason: "egress_token_invalid" });
    expect(await verify(await signed({ iss: subjectTokenIssuer(newTenantId()) }))).toEqual({
      ok: false,
      reason: "egress_token_invalid",
    });
    expect(await verifyEgressToken(runs.store, newTenantId(), await signed())).toMatchObject({ ok: false });
  });

  it("refuses a run, host, subject or delivery token presented as an egress token", async () => {
    const run = (await runs.run("egress-run")).token;
    const host = await signed({ aud: "nylorun-harness" }, "nylorun-host+jwt");
    const runShaped = await signed({ aud: RUN_TOKEN_AUD, sub: "s", trn: "t", agt: "a" }, RUN_TOKEN_TYP);
    const subject = await signed({ aud: SUBJECT_TOKEN_AUDIENCE, tnt: runs.tenantId, role: "user", scp: "", epc: 0 }, SUBJECT_TOKEN_TYPE);
    const delivery = await signed({ aud: "http://endpoint.invalid", gen: 1, bdy: "x" }, DELIVERY_TOKEN_TYPE);
    for (const token of [run, host, runShaped, subject, delivery])
      expect(await verify(token)).toEqual({ ok: false, reason: "egress_token_header" });
  });

  it("refuses missing or malformed claims and an overlong lifetime", async () => {
    const iat = Math.floor(Date.now() / 1000);
    for (const claims of [
      { sbx: undefined },
      { sbx: "" },
      { pod: undefined },
      { pod: 7 },
      { epc: 0 },
      { epc: 1.5 },
      { epc: "1" },
      { exp: iat + EGRESS_TOKEN_MAX_TTL_SECONDS * 2 },
    ])
      expect(await verify(await signed(claims))).toEqual({ ok: false, reason: "egress_token_claims" });
  });

  it("accepts an expiry within the 30 s tolerance, and refuses one past it", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await signed({ iat: now - 120, exp: now - 20 }))).toMatchObject({ ok: true });
    expect(await verify(await signed({ iat: now - 120, exp: now - 40 }))).toEqual({
      ok: false,
      reason: "egress_token_expired",
    });
  });

  it("refuses a token over 4 KiB and a header that could name another key", async () => {
    expect(await verify(await signed({ pad: "x".repeat(4096) }))).toEqual({
      ok: false,
      reason: "egress_token_malformed",
    });
    const [header, payload, signature] = (await signed()).split(".");
    for (const extra of [{ jku: "https://evil.invalid/jwks" }, { jwk: {} }, { x5u: "https://evil.invalid" }, { crit: ["exp"] }]) {
      const forged = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(header!, "base64url").toString()), ...extra }),
      ).toString("base64url");
      expect(await verify(`${forged}.${payload}.${signature}`)).toEqual({ ok: false, reason: "egress_token_header" });
    }
    expect(await verify(`${header}.${payload}.${"A".repeat(86)}`)).toEqual({ ok: false, reason: "egress_token_invalid" });
    expect(await verify("not-a-token")).toEqual({ ok: false, reason: "egress_token_malformed" });
  });

  it("refuses a token whose key was revoked, and verifies under a rotated key at once", async () => {
    const before = await signed();
    expect(await verify(before)).toMatchObject({ ok: true });
    await runs.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    expect(await verify(before)).toMatchObject({ ok: true });
    expect(await verify(await signed())).toMatchObject({ ok: true });
    await runs.keys.rotateSigningKeys({ maxTtlSeconds: 60, force: true });
    expect(await verify(before)).toEqual({ ok: false, reason: "egress_token_key_revoked" });
  });
});
