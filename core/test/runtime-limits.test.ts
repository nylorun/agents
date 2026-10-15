import { describe, expect, it } from "vitest";
import {
  HARNESS_LIMIT_DEFAULTS,
  HarnessLimitsSchema,
  JS_STRING_MAX_LENGTH,
  PutTenantLimitsRequestSchema,
  RUNTIME_LIMIT_CEILINGS,
  RUNTIME_LIMIT_DEFAULTS,
  RuntimeLimitsSchema,
  TIMER_MAX_MS,
  harnessLimitsOf,
  inlineBodyBytes,
  S2_RECORD_MAX_BYTES,
  TenantLimitsViewSchema,
  runtimeLimitIssues,
  runtimeLimitsOf,
} from "../src/contracts.js";
import { HARNESS_MAX_PAYLOAD, TurnStartSchema } from "../src/harness-api/index.js";

describe("Runtime limits", () => {
  it("defaults to today's sizes and times, each within its ceiling", () => {
    expect(HARNESS_LIMIT_DEFAULTS).toEqual({
      recordEntryBytes: 960 * 1024,
      modelCallBytes: 32 * 1024 * 1024,
      modelFileBytes: 8 * 1024 * 1024,
      toolAnswerBytes: 8 * 1024 * 1024,
      harnessStateBytes: 256 * 1024,
      chunkBytes: 16 * 1024 * 1024,
      folderEntries: 10_000,
    });
    // The values the literals they replace held (B15).
    expect(RUNTIME_LIMIT_DEFAULTS).toMatchObject({
      requestBodyBytes: 1024 * 1024,
      inlineFileBytes: 20 * 1024 * 1024,
      a2aWaitMs: 5 * 60_000,
      errorExcerptChars: 2_000,
      traceContentBytes: 8 * 1024,
      environmentLabels: 32,
      environmentSetupCommands: 16,
      environmentFiles: 16,
      environmentFilesPerEntry: 1_000,
      environmentSecretSlots: 64,
      setupCommandMs: 30 * 60_000,
      setupOutputChars: 4 * 1024,
      diskVersionEntries: 200_000,
      diskVersionBytes: 10 * 1024 ** 3,
      diskLeaseMs: 2 * 60_000,
      diskPodWaitMs: 60_000,
      modelRequestMs: 600_000,
      modelIdleMs: 300_000,
      modelAttempts: 3,
      modelRetryDelayMs: 2_000,
      modelProviderRetries: 2,
      modelRetryDelayMaxMs: 60_000,
      toolAttempts: 3,
      httpToolTimeoutMs: 300_000,
      mcpSnapshotBytes: 4 * 1024 * 1024,
      mcpPreviewMs: 15_000,
      mcpMetadataBytes: 64 * 1024,
    });
    // Every limit has a default and a ceiling, and the defaults are within them.
    expect(Object.keys(RUNTIME_LIMIT_DEFAULTS).sort()).toEqual(Object.keys(RUNTIME_LIMIT_CEILINGS).sort());
    expect(Object.keys(RuntimeLimitsSchema.shape).sort()).toEqual(Object.keys(RUNTIME_LIMIT_CEILINGS).sort());
    expect(runtimeLimitIssues(RUNTIME_LIMIT_DEFAULTS)).toEqual([]);
    for (const ceiling of Object.values(RUNTIME_LIMIT_CEILINGS)) expect(ceiling.why.length).toBeGreaterThan(20);
  });

  it("sends a harness only its own limits, and a harness drops one it does not know", () => {
    expect(harnessLimitsOf(RUNTIME_LIMIT_DEFAULTS)).toEqual(HARNESS_LIMIT_DEFAULTS);
    expect(HarnessLimitsSchema.parse({ ...HARNESS_LIMIT_DEFAULTS, newLimitBytes: 1 })).toEqual(HARNESS_LIMIT_DEFAULTS);
  });

  it("times with JavaScript timers, and reads an inline body of one file in base64 and the rest", () => {
    expect(RUNTIME_LIMIT_CEILINGS.a2aWaitMs).toMatchObject({ value: TIMER_MAX_MS, unit: "milliseconds" });
    expect(runtimeLimitIssues({ modelRequestMs: TIMER_MAX_MS + 1 })[0]).toContain("JavaScript timer");
    expect(inlineBodyBytes({ inlineFileBytes: 3 * 1024, requestBodyBytes: 1024 })).toBe(5 * 1024);
    // About the 28 MiB the endpoints read before (B15).
    expect(inlineBodyBytes(RUNTIME_LIMIT_DEFAULTS)).toBe(Math.ceil((20 * 1024 * 1024) / 3) * 4 + 1024 * 1024);
    expect(inlineBodyBytes({ inlineFileBytes: RUNTIME_LIMIT_CEILINGS.inlineFileBytes.value, requestBodyBytes: 1 })).toBe(
      JS_STRING_MAX_LENGTH,
    );
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
