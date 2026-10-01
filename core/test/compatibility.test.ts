import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  TENANT_ID_PATTERN,
  PRINCIPAL_ID_PATTERN,
  checkCompatibility,
  compareVersions,
  isPrincipalId,
  isTenantId,
  newPrincipalId,
  newTenantId,
} from "../src/compatibility.js";
import {
  AdminStatusSchema,
  ProjectCredentialsFileSchema,
  ProjectLinkFileSchema,
  RejectedResponseSchema,
} from "../src/contracts.js";

const CROCKFORD = /^[0-9a-hjkmnp-tv-z]+$/;

describe("tenant ids", () => {
  it("uses the Crockford alphabet, tn_ prefix and length 29", () => {
    const id = newTenantId(1_700_000_000_000);
    expect(id).toMatch(/^tn_/);
    expect(id).toHaveLength(29);
    expect(id.slice(3)).toMatch(CROCKFORD);
    expect(id).toMatch(TENANT_ID_PATTERN);
    expect(isTenantId(id)).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isTenantId("tn_00000000000000000000000000")).toBe(true);
    expect(isTenantId("tn_iiiiiiiiiiiiiiiiiiiiiiiiii")).toBe(false);
    expect(isTenantId("tn_OOOOOOOOOOOOOOOOOOOOOOOOOO")).toBe(false);
    expect(isTenantId("tn_short")).toBe(false);
    expect(isTenantId("host_00000000000000000000000000")).toBe(false);
    expect(isTenantId(null)).toBe(false);
  });

  it("keeps a monotonic time prefix for a fixed clock", () => {
    const earlier = newTenantId(1_000);
    const later = newTenantId(2_000);
    expect(earlier.slice(3, 13) < later.slice(3, 13)).toBe(true);
  });

  it("stays lexicographically monotonic within the same millisecond", () => {
    const ids = Array.from({ length: 32 }, () => newTenantId(42));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
      expect(ids[i]!.slice(3, 13)).toBe(ids[0]!.slice(3, 13));
    }
  });
});

describe("principal ids", () => {
  it("uses the Crockford alphabet, pr_ prefix and length 29", () => {
    const id = newPrincipalId(1_700_000_000_000);
    expect(id).toMatch(/^pr_/);
    expect(id).toHaveLength(29);
    expect(id.slice(3)).toMatch(CROCKFORD);
    expect(id).toMatch(PRINCIPAL_ID_PATTERN);
    expect(isPrincipalId(id)).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders SemVer including prereleases", () => {
    expect(compareVersions("0.9.0-beta", "0.9.0")).toBe(-1);
    expect(compareVersions("0.9.0", "0.9.0-beta")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});

describe("Wave 0 schemas", () => {
  it("parses AdminStatusSchema with optional host", () => {
    const body = {
      service: "nylorun-runtime",
      version: "0.9.0-beta",
      protocol: {
        min: 2,
        max: 2,
        features: ["runtime-tenants", "admin-status"],
      },
      tenants: [],
      aggregate: {
        runningSessions: 0,
        inFlightDeliveries: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      },
      host: { hostId: "host_1", url: "http://127.0.0.1:7432", pid: 1 },
    };
    expect(AdminStatusSchema.parse(body).host?.hostId).toBe("host_1");
    const { host: _host, ...cloud } = body;
    expect(AdminStatusSchema.parse(cloud).host).toBeUndefined();
  });

  it("defaults Project link format to 0", () => {
    const link = ProjectLinkFileSchema.parse({
      hostUrl: "http://127.0.0.1:7432",
      hostId: "host_1",
      tenantId: "tn_00000000000000000000000000",
    });
    expect(link.format).toBe(0);
  });

  it("parses Project credentials", () => {
    expect(
      ProjectCredentialsFileSchema.parse({
        format: 1,
        applicationKey: "a".repeat(64),
        principalId: "pr_00000000000000000000000000",
      }).format,
    ).toBe(1);
  });

  it("parses RejectedResponseSchema with registry codes", () => {
    expect(
      RejectedResponseSchema.parse({
        status: "rejected",
        code: "host_rejected",
        message: "bad Host",
        details: { header: "evil.example" },
      }).code,
    ).toBe("host_rejected");
  });
});

describe("checkCompatibility", () => {
  it("accepts a client inside the host range with required features", () => {
    expect(
      checkCompatibility(
        { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
        HOST_PROTOCOL,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an out-of-range protocol version", () => {
    expect(
      checkCompatibility({ version: 1, required: [] }, HOST_PROTOCOL),
    ).toEqual({
      ok: false,
      reason: "version",
      client: 1,
      host: HOST_PROTOCOL,
    });
  });

  it("rejects missing required features", () => {
    expect(
      checkCompatibility(
        { version: PROTOCOL_VERSION, required: ["runtime-tenants", "missing-feature"] },
        HOST_PROTOCOL,
      ),
    ).toEqual({
      ok: false,
      reason: "feature",
      missing: ["missing-feature"],
      host: HOST_PROTOCOL,
    });
  });

  it("advertises admin-status", () => {
    expect(PROTOCOL_FEATURES).toContain("admin-status");
  });
});
