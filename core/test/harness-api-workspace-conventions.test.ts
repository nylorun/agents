/**
 * The Harness API's contracts for workspace conventions (protocol 15): compaction as an explicit
 * transcript edit, `purpose: "summary"` on model intents, the folder mode of `artifact.write`,
 * and the claims of the outputs folder.
 */
import { describe, expect, it } from "vitest";
import {
  EffectIntentSchema,
  HARNESS_CLAIMS,
  TranscriptUpdateSchema,
  applyUpdates,
  harnessRequests,
  transcriptUpdates,
} from "../src/harness-api/index.js";

const facts = { trigger: "threshold" as const, tokensBefore: 900, tokensAfter: 120, summaryEffectIds: ["t1:0:model:c"] };

describe("a compaction edit", () => {
  it("marks the first chunk of the edit with the facts, and folds like any edit", () => {
    const before = ["a", "b", "c"].map((text) => ({ kind: "input", text }));
    const after = [{ kind: "compaction", summary: "x".repeat(40) }, { kind: "input", text: "c" }];
    const updates = transcriptUpdates(before, after, 30, facts);
    expect(updates.length).toBeGreaterThan(1);
    expect(updates[0]).toMatchObject({ kind: "compaction", keep: 0, compaction: facts });
    expect(updates.slice(1).every((update) => !("compaction" in update))).toBe(true);
    for (const update of updates) expect(TranscriptUpdateSchema.safeParse(update).success).toBe(true);
    expect(applyUpdates(before, updates)).toEqual(after);
    // Without facts, nothing is marked; nothing changed, nothing is sent.
    expect(transcriptUpdates(before, after).some((update) => "kind" in update)).toBe(false);
    expect(transcriptUpdates(before, before, undefined, facts)).toEqual([]);
  });

  it("names at least one summary call", () => {
    const edit = { kind: "compaction", keep: 0, entries: [], length: 0 };
    expect(TranscriptUpdateSchema.safeParse({ ...edit, compaction: { ...facts, summaryEffectIds: [] } }).success).toBe(false);
    expect(TranscriptUpdateSchema.safeParse({ ...edit, compaction: { ...facts, partial: true } }).success).toBe(false);
    expect(TranscriptUpdateSchema.safeParse({ keep: 0, entries: [], length: 0, compaction: facts }).success).toBe(false);
  });

  it("is written by model intents that say purpose summary", () => {
    const intent = {
      effectId: "t1:0:model:c",
      sessionId: "s1",
      turnId: "t1",
      agentId: "bot",
      manifestHash: "h",
      kind: "model",
      context: { invocationId: "c" },
    };
    expect(EffectIntentSchema.safeParse({ ...intent, purpose: "summary" }).success).toBe(true);
    expect(EffectIntentSchema.safeParse({ ...intent, purpose: "other" }).success).toBe(false);
  });
});

describe("artifact.write in folder mode", () => {
  const params = harnessRequests["artifact.write"].params;
  const result = harnessRequests["artifact.write"].result;
  const hex = "a".repeat(64);

  it("opens a folder, takes files by hash, and chunks that name their file", () => {
    expect(params.safeParse({ runId: "r", op: "begin", kind: "folder", key: "outputs:t1", name: "outputs", sameName: true }).success).toBe(true);
    // A folder has a name; a file's fields are not a folder's.
    expect(params.safeParse({ runId: "r", op: "begin", kind: "folder", key: "k" }).success).toBe(false);
    expect(params.safeParse({ runId: "r", op: "begin", kind: "folder", key: "k", name: "o", base64: "" }).success).toBe(false);
    expect(params.safeParse({ runId: "r", op: "file", uploadId: "u", path: "a.txt", size: 1, sha256: hex, base64: "YQ==" }).success).toBe(true);
    expect(params.safeParse({ runId: "r", op: "file", uploadId: "u", path: "a.txt", size: 1, sha256: "nope" }).success).toBe(false);
    expect(params.safeParse({ runId: "r", op: "chunk", uploadId: "u", sha256: hex, offset: 0, base64: "YQ==" }).success).toBe(true);
  });

  it("answers its limits, unchanged versions and refusals past a total", () => {
    expect(result.safeParse({ status: "open", uploadId: "u", maxBytes: 9, maxFileBytes: 3, maxEntries: 2, received: 0 }).success).toBe(true);
    expect(result.safeParse({ status: "refused", reason: "tenant_total", message: "full", limit: 9 }).success).toBe(true);
    expect(result.safeParse({ status: "refused", reason: "too_large", message: "full", limit: 9 }).success).toBe(false);
  });

  it("lets a harness claim why the outputs folder stored nothing", () => {
    expect(HARNESS_CLAIMS).toContain("artifact.export.skipped");
    expect(HARNESS_CLAIMS).toContain("artifact.export.failed");
  });
});
