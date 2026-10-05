import { describe, expect, it } from "vitest";
import { deriveStudioToken } from "../src/index.js";

const ADMIN_KEY = "a".repeat(64);
describe("deriveStudioToken", () => {
  it("matches a fixed vector computed independently (Python hmac)", () => {
    // hmac.new(b"a"*64, b"nylorun/studio/v2", sha256).hexdigest()
    expect(deriveStudioToken(ADMIN_KEY)).toBe(
      "5d79cf3e21c23cc6b6b2ce772428d23c3e86a24a97d1a39e0e22a11f87f70753",
    );
  });

  it("is stable, 64 hex, and distinct from the admin key and per admin key", () => {
    const a = deriveStudioToken(ADMIN_KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(ADMIN_KEY);
    expect(deriveStudioToken(ADMIN_KEY)).toBe(a);
    expect(deriveStudioToken("b".repeat(64))).not.toBe(a);
  });
});

describe("derived keys (protocol 7)", () => {
  it("derives the Studio key only: every other key is an operator key", async () => {
    const admin = await import("../src/index.js");
    expect("deriveTenantKey" in admin).toBe(false);
    expect("PROJECT_PRINCIPAL_ID" in admin).toBe(false);
  });
});
