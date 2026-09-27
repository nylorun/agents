import { expect, it } from "vitest";

it("every quarantine code carries a CLI repair string", async () => {
  const { repairFor } = await import("../../src/tenant/quarantine.js");
  const codes = [
    "kek-missing",
    "corrupt",
    "schema-too-new",
    "migration-failed",
    "envelope-invalid",
    "open-timeout",
    "open-failed",
  ] as const;
  for (const code of codes) {
    const repair = repairFor(code, { tenantId: "tn_test" });
    expect(repair.length).toBeGreaterThan(0);
    expect(repair).toMatch(/nylorun|restore/);
  }
});
