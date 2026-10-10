/**
 * One history (blueprint P0.3): the edits a settled segment records and the fold that rebuilds
 * the transcript from them.
 */
import { describe, expect, it } from "vitest";
import {
  TranscriptFoldError,
  applyUpdate,
  foldTranscript,
  transcriptUpdates,
  type TranscriptUpdate,
} from "../../src/tenant/history.js";

const entry = (n: number, size = 0) => ({ kind: "input", n, pad: "x".repeat(size) });
const updated = (turnId: string | null, payload: TranscriptUpdate) => ({
  type: "transcript.updated",
  turnId,
  payload,
});
const fold = (...events: { type: string; turnId: string | null; payload?: unknown }[]) =>
  foldTranscript(events.map((event) => ({ payload: undefined, ...event })));

describe("transcriptUpdates", () => {
  it("appends only the new entries", () => {
    expect(transcriptUpdates([entry(1)], [entry(1), entry(2), entry(3)])).toEqual([
      { keep: 1, entries: [entry(2), entry(3)], length: 3 },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(transcriptUpdates([entry(1)], [entry(1)])).toEqual([]);
  });

  it("is a snapshot when the prefix changed (compaction)", () => {
    const compacted = [{ kind: "compaction", summary: "s" }, entry(3)];
    expect(transcriptUpdates([entry(1), entry(2), entry(3)], compacted)).toEqual([
      { keep: 0, entries: compacted, length: 2 },
    ]);
  });

  it("splits large edits into chunks that each append to the last", () => {
    const after = [entry(1, 60), entry(2, 60), entry(3, 60)];
    const updates = transcriptUpdates([], after, 100);
    expect(updates.map((u) => [u.keep, u.entries.length, u.length])).toEqual([
      [0, 1, 1],
      [1, 1, 2],
      [2, 1, 3],
    ]);
    expect(updates.reduce<unknown[]>((t, u) => applyUpdate(t, u), [])).toEqual(after);
  });
});

describe("foldTranscript", () => {
  it("applies edits in order", () => {
    expect(
      fold(
        updated("t1", { keep: 0, entries: [entry(1), entry(2)], length: 2 }),
        { type: "turn.completed", turnId: "t1" },
        updated("t2", { keep: 2, entries: [entry(3)], length: 3 })
      )
    ).toEqual([entry(1), entry(2), entry(3)]);
  });

  it("restores the transcript from before a cancelled or failed turn", () => {
    for (const end of ["turn.cancelled", "turn.failed"])
      expect(
        fold(
          updated("t1", { keep: 0, entries: [entry(1)], length: 1 }),
          { type: "turn.completed", turnId: "t1" },
          updated("t2", { keep: 1, entries: [entry(2)], length: 2 }),
          updated("t2", { keep: 2, entries: [entry(3)], length: 3 }),
          { type: end, turnId: "t2" }
        )
      ).toEqual([entry(1)]);
  });

  it("keeps a paused turn's edits when it resumes", () => {
    expect(
      fold(
        updated("t1", { keep: 0, entries: [entry(1)], length: 1 }),
        { type: "turn.paused", turnId: "t1" },
        updated("t1", { keep: 1, entries: [entry(2)], length: 2 }),
        { type: "turn.completed", turnId: "t1" }
      )
    ).toEqual([entry(1), entry(2)]);
  });

  it("ignores a cancel of a turn that recorded nothing", () => {
    expect(
      fold(updated("t1", { keep: 0, entries: [entry(1)], length: 1 }), {
        type: "turn.cancelled",
        turnId: "t2",
      })
    ).toEqual([entry(1)]);
  });

  it("refuses an edit that does not fit", () => {
    expect(() => fold(updated("t1", { keep: 1, entries: [], length: 1 }))).toThrow(
      TranscriptFoldError
    );
    expect(() => fold(updated("t1", { keep: 0, entries: [entry(1)], length: 2 }))).toThrow(
      TranscriptFoldError
    );
  });
});
