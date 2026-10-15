import { describe, expect, it } from "vitest";
import {
  PutTenantLimitsRequestSchema,
  RUNTIME_LIMIT_CEILINGS,
  RUNTIME_LIMIT_DEFAULTS,
  S2_RECORD_MAX_BYTES,
  TenantLimitsViewSchema,
  runtimeLimitIssues,
  runtimeLimitsOf,
} from "../src/contracts.js";
import { HARNESS_MAX_PAYLOAD, TurnStartSchema } from "../src/harness-api/index.js";

describe("Runtime limits", () => {
  it("defaults to today's sizes, each within its ceiling", () => {
    expect(RUNTIME_LIMIT_DEFAULTS).toEqual({
      recordEntryBytes: 960 * 1024,
      modelCallBytes: 32 * 1024 * 1024,
      modelFileBytes: 8 * 1024 * 1024,
      toolAnswerBytes: 8 * 1024 * 1024,
      harnessStateBytes: 256 * 1024,
      chunkBytes: 16 * 1024 * 1024,
      folderEntries: 10_000,
    });
    expect(runtimeLimitIssues(RUNTIME_LIMIT_DEFAULTS)).toEqual([]);
  });

  it("takes its ceilings from the dependencies", () => {
    // An event's JSON is one S2 record's body: its payload leaves room for the envelope.
    expect(RUNTIME_LIMIT_CEILINGS.recordEntryBytes.value).toBeLessThan(S2_RECORD_MAX_BYTES);
    // A chunk crosses in base64 in one frame, with room for the frame's JSON.
    const base64 = Math.ceil(RUNTIME_LIMIT_CEILINGS.chunkBytes.value / 3) * 4;
    expect(base64).toBeLessThan(HARNESS_MAX_PAYLOAD);
    expect(HARNESS_MAX_PAYLOAD - base64).toBeGreaterThan(64 * 1024);
    expect(RUNTIME_LIMIT_CEILINGS.toolAnswerBytes.value).toBe(HARNESS_MAX_PAYLOAD / 2);
    // A folder's manifest is one string: its entries fit the longest one.
    expect(RUNTIME_LIMIT_CEILINGS.folderEntries.unit).toBe("entries");
    expect(RUNTIME_LIMIT_CEILINGS.folderEntries.value).toBeGreaterThan(RUNTIME_LIMIT_DEFAULTS.folderEntries);
  });

  it("counts folderEntries in entries, not bytes", () => {
    const issues = runtimeLimitIssues({ folderEntries: RUNTIME_LIMIT_CEILINGS.folderEntries.value + 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("entries; its ceiling is");
  });

  it("names the ceiling a limit passes", () => {
    const issues = runtimeLimitIssues({ recordEntryBytes: S2_RECORD_MAX_BYTES, modelCallBytes: 1024 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("limits.recordEntryBytes");
    expect(issues[0]).toContain(String(RUNTIME_LIMIT_CEILINGS.recordEntryBytes.value));
    expect(issues[0]).toContain("S2");
  });

  it("fills what a Tenant leaves out with the defaults", () => {
    expect(runtimeLimitsOf(undefined)).toEqual(RUNTIME_LIMIT_DEFAULTS);
    expect(runtimeLimitsOf({ modelCallBytes: 1024 })).toEqual({ ...RUNTIME_LIMIT_DEFAULTS, modelCallBytes: 1024 });
    expect(TenantLimitsViewSchema.safeParse({ limits: runtimeLimitsOf({}) }).success).toBe(true);
  });

  it("puts only known, positive limits", () => {
    expect(PutTenantLimitsRequestSchema.safeParse({ limits: { chunkBytes: 1024 } }).success).toBe(true);
    expect(PutTenantLimitsRequestSchema.safeParse({}).success).toBe(true);
    expect(PutTenantLimitsRequestSchema.safeParse({ limits: { chunkBytes: 0 } }).success).toBe(false);
    expect(PutTenantLimitsRequestSchema.safeParse({ limits: { frameBytes: 1 } }).success).toBe(false);
  });

  it("is part of every turn.start", () => {
    const start = {
      type: "turn.start",
      engine: "agent",
      manifest: {},
      checkpoint: {},
      outcomes: [],
      transcript: { cursor: 0 },
      options: { fixtureModel: false },
      routing: { rootManifest: {} },
    };
    expect(TurnStartSchema.safeParse(start).success).toBe(false);
    expect(TurnStartSchema.safeParse({ ...start, limits: RUNTIME_LIMIT_DEFAULTS }).success).toBe(true);
  });
});
