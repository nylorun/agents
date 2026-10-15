/**
 * Transcript edits (blueprint P0.3): a segment's transcript changes are recorded as
 * `transcript.updated` events, each an edit of the transcript before it. Shared by core, which
 * records and folds them, and a harness, which computes them and keeps its cache with them.
 */
import type { z } from "zod";
import type { CompactionFactsSchema, TranscriptUpdateSchema } from "./schema.js";

/** The payload of one `transcript.updated` event. */
export type TranscriptUpdate = z.infer<typeof TranscriptUpdateSchema>;

export class TranscriptFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptFoldError";
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The engine state's transcript, or none. */
export function transcriptOf(state: unknown): unknown[] {
  const transcript = (state as { transcript?: unknown } | undefined)?.transcript;
  return Array.isArray(transcript) ? transcript : [];
}

/** `state` with `transcript` (what the engine runs on). */
export function withTranscript<T>(state: T, transcript: readonly unknown[]): T {
  if (!state) return state;
  return { ...state, transcript: [...transcript] };
}

/** The bytes of `text` as UTF-8, as the record measures an entry. */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The edits from `before` to `after`, each one `transcript.updated` event: an edit's entries fill
 * each event up to `recordEntryBytes` (the run's `turn.start.limits`), the most one record entry
 * holds, with room for the edit's own fields. An entry larger than that is an event of its own,
 * which the record refuses (`limit_exceeded`). Empty when nothing changed. With `compaction`, the
 * edit replaced older history with a summary: its first event says so (`kind: "compaction"`,
 * with the facts).
 */
export function transcriptUpdates(
  before: readonly unknown[],
  after: readonly unknown[],
  recordEntryBytes: number,
  compaction?: z.infer<typeof CompactionFactsSchema>
): TranscriptUpdate[] {
  // The fields beside the entries, at their longest: the first event's, and every other's.
  const fields = utf8Bytes(
    JSON.stringify({
      kind: "compaction",
      keep: Number.MAX_SAFE_INTEGER,
      entries: [],
      length: Number.MAX_SAFE_INTEGER,
      ...(compaction === undefined ? {} : { compaction }),
    })
  );
  const updates = edits(before, after, recordEntryBytes - fields);
  if (compaction === undefined || updates.length === 0) return updates;
  const [first, ...rest] = updates;
  return [{ kind: "compaction", ...first!, compaction }, ...rest];
}

function edits(before: readonly unknown[], after: readonly unknown[], entryBytes: number): TranscriptUpdate[] {
  let keep = 0;
  while (keep < before.length && keep < after.length && same(before[keep], after[keep])) keep += 1;
  if (keep === before.length && keep === after.length) return [];
  const added = after.slice(keep);
  if (added.length === 0) return [{ keep, entries: [], length: keep }];
  const updates: TranscriptUpdate[] = [];
  let chunk: unknown[] = [];
  let bytes = 0;
  let base = keep;
  const flush = () => {
    updates.push({ keep: base, entries: chunk, length: base + chunk.length });
    base += chunk.length;
    chunk = [];
    bytes = 0;
  };
  for (const entry of added) {
    // The entry's JSON and the comma before the next.
    const size = utf8Bytes(JSON.stringify(entry)) + 1;
    if (chunk.length > 0 && bytes + size > entryBytes) flush();
    chunk.push(entry);
    bytes += size;
  }
  flush();
  return updates;
}

/** Applies one edit. Throws `TranscriptFoldError` when it does not fit the transcript. */
export function applyUpdate(transcript: readonly unknown[], update: TranscriptUpdate): unknown[] {
  if (update.keep > transcript.length)
    throw new TranscriptFoldError(
      `transcript.updated keeps ${update.keep} entries of ${transcript.length}`
    );
  const next = [...transcript.slice(0, update.keep), ...update.entries];
  if (next.length !== update.length)
    throw new TranscriptFoldError(
      `transcript.updated should give ${update.length} entries, not ${next.length}`
    );
  return next;
}

/** Applies edits in order. */
export function applyUpdates(
  transcript: readonly unknown[],
  updates: readonly TranscriptUpdate[]
): unknown[] {
  let next = [...transcript];
  for (const update of updates) next = applyUpdate(next, update);
  return next;
}
