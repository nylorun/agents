import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  basinOf,
  parseBasin,
  tenantBasinName,
  validateBasinPrefix,
} from "../../src/streams/basin.js";

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

  it("names each basin generation apart, within S2's 48 characters", () => {
    const tenantId = newTenantId();
    expect(basinOf(tenantId, 0)).toBe(tenantId);
    expect(parseBasin(basinOf(tenantId, 7))).toEqual({ tenantId, generation: 7 });
    expect(parseBasin(tenantId)).toEqual({ tenantId, generation: 0 });
    expect(tenantBasinName(basinOf(tenantId, 1), "a-long-prefix-16")).toBe(
      `a-long-prefix-16tn-${tenantId.slice(3)}-1`,
    );
    const names = [0, 1, 35, 36, 1295].map((g) =>
      tenantBasinName(basinOf(tenantId, g), "a-long-prefix-16"),
    );
    for (const name of names) expect(name).toMatch(S2_BASIN);
    expect(new Set(names).size).toBe(names.length);
    expect(names[4]!.length).toBe(48);
    expect(tenantBasinName(basinOf("tn_x", 2))).not.toBe(tenantBasinName("tn_x"));
    expect(tenantBasinName(basinOf("tn_x", 2))).toMatch(S2_BASIN);
    expect(() => basinOf(tenantId, -1)).toThrow();
  });
});
