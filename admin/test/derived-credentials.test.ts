import { describe, expect, it } from "vitest";
import { deriveStudioToken, deriveTenantKey } from "../src/index.js";

const ADMIN_KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000001";

describe("deriveStudioToken", () => {
  it("matches a fixed vector computed independently (Python hmac)", () => {
    // hmac.new(b"a"*64, b"nylorun/studio/v1\x00" + tenant, sha256).hexdigest()
    expect(deriveStudioToken(ADMIN_KEY, TENANT)).toBe(
      "9fa6c30ff411394ef699c34d3a5f50163a6f82c12490c1be3d44e47e97de3a10",
    );
  });

  it("is stable, 64 hex, distinct per Tenant and from the admin key", () => {
    const a = deriveStudioToken(ADMIN_KEY, TENANT);
    const b = deriveStudioToken(ADMIN_KEY, "tn_00000000000000000000000002");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(ADMIN_KEY);
    expect(deriveStudioToken(ADMIN_KEY, TENANT)).toBe(a);
    expect(deriveStudioToken("b".repeat(64), TENANT)).not.toBe(a);
  });
});

describe("deriveTenantKey", () => {
  it("matches a fixed vector computed independently (Python hmac)", () => {
    // hmac.new(b"a"*64, b"nylorun/principal/v1\x00babai\x00" + tenant, sha256).hexdigest()
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "babai")).toBe(
      "e75e386ac70503370967006bf76ba46b6c9603ca52e282bcfac2f8f972ea771c",
    );
  });

  it("is stable and distinct per principal, Tenant, admin key and from Studio's key", () => {
    const a = deriveTenantKey(ADMIN_KEY, TENANT, "babai");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "babai")).toBe(a);
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "other")).not.toBe(a);
    expect(
      deriveTenantKey(ADMIN_KEY, "tn_00000000000000000000000002", "babai"),
    ).not.toBe(a);
    expect(deriveTenantKey("b".repeat(64), TENANT, "babai")).not.toBe(a);
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "studio")).not.toBe(
      deriveStudioToken(ADMIN_KEY, TENANT),
    );
  });
});
