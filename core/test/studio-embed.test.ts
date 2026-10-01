import { describe, expect, it } from "vitest";
import {
  STUDIO_EMBED_MESSAGE_TYPE,
  StudioEmbedMessageSchema,
  StudioLoginTokenRequestSchema,
  StudioThemeSchema,
  isFrameAncestor,
  parseFrameAncestors,
} from "../src/contracts.js";

const envelope = { type: STUDIO_EMBED_MESSAGE_TYPE, protocol: 1 } as const;

describe("StudioEmbedMessageSchema", () => {
  const messages = [
    { kind: "ready", protocols: [1], studioVersion: "0.13.0-beta" },
    {
      kind: "init",
      token: "t",
      theme: { mode: "dark" },
      route: "/tenants/ten_1/sessions/s1",
    },
    { kind: "token.refresh", token: "t" },
    { kind: "theme.changed", theme: { mode: "light", accent: "#336699" } },
    { kind: "navigate", route: "/tenants/ten_1" },
    { kind: "session", tenant: "ten_1", subject: "user_1", expiresAt: "2026-10-01T00:00:00Z" },
    { kind: "token.expiring", expiresAt: null },
    { kind: "route.changed", route: "/tenants/ten_1/vault" },
    { kind: "open.external", url: "https://docs.nylorun.com" },
    { kind: "open.babai", sessionId: "s1" },
    { kind: "error", code: "token_invalid", message: "expired" },
  ];

  it.each(messages)("round-trips $kind", (message) => {
    const value = { ...envelope, ...message };
    expect(StudioEmbedMessageSchema.parse(value)).toEqual(value);
  });

  it("refuses another type, an unknown kind and a non-web external URL", () => {
    const bad = [
      { ...envelope, type: "other", kind: "ready", protocols: [1], studioVersion: "x" },
      { ...envelope, kind: "explode" },
      { ...envelope, kind: "open.external", url: "javascript:alert(1)" },
      { ...envelope, kind: "navigate", route: "/settings" },
      { ...envelope, kind: "navigate", route: "https://evil.example/tenants/x" },
      { ...envelope, protocol: 0, kind: "token.refresh", token: "t" },
    ];
    for (const value of bad)
      expect(StudioEmbedMessageSchema.safeParse(value).success).toBe(false);
  });

  it("drops unknown theme keys", () => {
    expect(StudioThemeSchema.parse({ mode: "dark", radius: 4 })).toEqual({ mode: "dark" });
    expect(StudioThemeSchema.safeParse({ mode: "dark", accent: "red" }).success).toBe(false);
  });
});

describe("StudioLoginTokenRequestSchema", () => {
  it("accepts {} and a Tenant with a subject", () => {
    expect(StudioLoginTokenRequestSchema.parse({})).toEqual({});
    expect(StudioLoginTokenRequestSchema.parse({ tenant: "ten_1", subject: "user 1" })).toEqual({
      tenant: "ten_1",
      subject: "user 1",
    });
  });

  it("refuses a bad Tenant id, a bad subject and unknown keys", () => {
    for (const value of [
      { tenant: "../x" },
      { subject: "" },
      { subject: " padded" },
      { subject: "x".repeat(201) },
      { tenant: "ten_1", admin: true },
    ])
      expect(StudioLoginTokenRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("parseFrameAncestors", () => {
  it("accepts exact origins", () => {
    for (const origin of [
      "nylorun://localhost",
      "http://nylorun.localhost",
      "https://nylorun.localhost",
      "http://localhost:1420",
      "https://app.example.com",
    ])
      expect(isFrameAncestor(origin), origin).toBe(true);
    expect(
      parseFrameAncestors("  nylorun://localhost\thttp://nylorun.localhost nylorun://localhost "),
    ).toEqual(["nylorun://localhost", "http://nylorun.localhost"]);
    expect(parseFrameAncestors("")).toEqual([]);
  });

  it("refuses wildcards, keywords, scheme-only entries and paths", () => {
    for (const entry of [
      "*",
      "https://*.example.com",
      "*.localhost",
      "nylorun:",
      "nylorun://",
      "http://localhost/x",
      "http://localhost:1420/",
      "'self'",
      "'none'",
      "null",
      "http://u:p@localhost",
      "HTTP://LOCALHOST",
      "javascript://x",
      "data://x",
      "nylorun://localhost:99999",
    ]) {
      expect(isFrameAncestor(entry), entry).toBe(false);
      expect(() => parseFrameAncestors(`nylorun://localhost ${entry}`)).toThrow(entry);
    }
  });
});
