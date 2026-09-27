import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { tenantBasinName, validateBasinPrefix } from "../../src/streams/basin.js";

const S2_BASIN = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;

describe("tenantBasinName", () => {
  it("maps a Tenant id to tn-<ulid>", () => {
    const tenantId = newTenantId();
    expect(tenantBasinName(tenantId)).toBe(`tn-${tenantId.slice(3)}`);
    expect(tenantBasinName(tenantId, "nylorun-")).toBe(`nylorun-tn-${tenantId.slice(3)}`);
    expect(tenantBasinName(tenantId, "a-long-prefix-16")).toMatch(S2_BASIN);
  });

  it("maps other ids to valid, distinct names", () => {
    const ids = ["tn_x", "TN_X", "tn-x", "tn x", "a", "_", `tn_${"Z".repeat(26)}`, "x".repeat(200)];
    const names = ids.map((id) => tenantBasinName(id, "a-long-prefix-16"));
    for (const name of names) expect(name).toMatch(S2_BASIN);
    expect(new Set(names).size).toBe(ids.length);
    expect(tenantBasinName("tn_x")).toMatch(/^x-tn-x-[0-9a-f]{16}$/);
    expect(tenantBasinName("tn_x")).toBe(tenantBasinName("tn_x"));
  });

  it("keeps canonical and fallback names apart", () => {
    const tenantId = newTenantId();
    expect(tenantBasinName(tenantId)).not.toBe(tenantBasinName(`tn-${tenantId.slice(3)}`));
  });

  it("rejects invalid prefixes and empty ids", () => {
    expect(() => validateBasinPrefix("Bad")).toThrow();
    expect(() => validateBasinPrefix("-lead")).toThrow();
    expect(() => validateBasinPrefix("x".repeat(17))).toThrow();
    expect(validateBasinPrefix("")).toBe("");
    expect(() => tenantBasinName("")).toThrow();
  });
});
