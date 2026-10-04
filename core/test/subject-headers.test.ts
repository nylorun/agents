import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  SCOPES_HEADER,
  SUBJECT_HEADER,
} from "../src/compatibility.js";
import { CreateVaultRequestSchema, SUBJECT_SCOPES, parseSubjectHeaders } from "../src/contracts.js";

describe("parseSubjectHeaders", () => {
  it("returns the subject and its scopes, collapsing duplicates", () => {
    const parsed = parseSubjectHeaders("app:42", "sessions:own  agents:read sessions:own");
    expect(parsed).toEqual({
      ok: true,
      subject: "app:42",
      scopes: new Set(["sessions:own", "agents:read"]),
    });
  });

  it("accepts the retired vaults:own and grants nothing for it (protocol 6 clients send it)", () => {
    expect(SUBJECT_SCOPES).not.toContain("vaults:own");
    expect(parseSubjectHeaders("app:42", "sessions:own vaults:own")).toEqual({
      ok: true,
      subject: "app:42",
      scopes: new Set(["sessions:own"]),
    });
  });

  it("requires scopes and knows only the listed ones", () => {
    expect(parseSubjectHeaders("app:42", undefined).ok).toBe(false);
    expect(parseSubjectHeaders("app:42", " ").ok).toBe(false);
    expect(parseSubjectHeaders("app:42", "sessions:all").ok).toBe(false);
    for (const scope of SUBJECT_SCOPES)
      expect(parseSubjectHeaders("app:42", scope).ok).toBe(true);
  });

  it("accepts 1-200 visible ASCII characters and reserves host and installation", () => {
    expect(parseSubjectHeaders("a", "agents:read").ok).toBe(true);
    expect(parseSubjectHeaders("Ada Lovelace", "agents:read").ok).toBe(true);
    expect(parseSubjectHeaders("x".repeat(200), "agents:read").ok).toBe(true);
    for (const subject of ["", " ada", "ada ", "x".repeat(201), "ada\tl", "ünï", "host", "installation"])
      expect(parseSubjectHeaders(subject, "agents:read").ok, JSON.stringify(subject)).toBe(false);
  });

  it("names the headers and the Host feature", () => {
    expect(SUBJECT_HEADER).toBe("Nylorun-Subject");
    expect(SCOPES_HEADER).toBe("Nylorun-Scopes");
    expect(HOST_PROTOCOL.features).toContain("subject-headers");
  });
});

describe("CreateVaultRequestSchema", () => {
  const base = { requestId: "r1", idempotencyKey: "k1", name: "GitHub" };

  it("needs an owner for a user vault and none for an installation vault", () => {
    expect(CreateVaultRequestSchema.safeParse({ ...base, ownerUserId: "ada" }).success).toBe(true);
    expect(CreateVaultRequestSchema.safeParse({ ...base, scope: "installation" }).success).toBe(true);
    expect(
      CreateVaultRequestSchema.safeParse({ ...base, scope: "installation", ownerUserId: "installation" }).success,
    ).toBe(true);
    expect(CreateVaultRequestSchema.safeParse(base).success).toBe(false);
    expect(CreateVaultRequestSchema.safeParse({ ...base, ownerUserId: "installation" }).success).toBe(false);
    expect(CreateVaultRequestSchema.safeParse({ ...base, scope: "installation", ownerUserId: "ada" }).success).toBe(false);
    expect(CreateVaultRequestSchema.safeParse({ ...base, scope: "host" }).success).toBe(false);
  });
});
