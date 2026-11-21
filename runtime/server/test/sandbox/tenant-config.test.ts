import { describe, expect, it } from "vitest";
import { ENVIRONMENTS_CONFIG_SETTING, readSandboxConfig } from "../../src/sandbox/tenant-config.js";

const reader = (stored: unknown) => ({
  getSetting: async (key: string) => (key === ENVIRONMENTS_CONFIG_SETTING ? JSON.stringify(stored) : undefined),
});

describe("the Tenant's stored sandbox settings", () => {
  it("drops engine.images an older Runtime stored (ADR-161)", async () => {
    const config = await readSandboxConfig(
      reader({ limits: { idle: "30m" }, engine: { images: ["ghcr.io/nylorun/dev"] }, lifecycle: { stopGrace: "20s" } }),
    );
    expect(config).toEqual({ limits: { idle: "30m" }, lifecycle: { stopGrace: "20s" } });
  });

  it("still refuses a stored setting it doesn't know", async () => {
    await expect(readSandboxConfig(reader({ limits: { idle: "30m" }, other: true }))).rejects.toThrow();
  });
});
