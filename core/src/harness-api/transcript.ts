/**
 * Transcript edits (blueprint P0.3): a segment's transcript changes are recorded as
 * `transcript.updated` events, each an edit of the transcript before it. Shared by core, which
 * records and folds them, and a harness, which computes them and keeps its cache with them.
 */
import type { z } from "zod";
import type { TranscriptUpdateSchema } from "./schema.js";

/** The payload of one `transcript.updated` event. */
export type TranscriptUpdate = z.infer<typeof TranscriptUpdateSchema>;

/**
 * An edit's entries are split so each event stays well under S2's 1 MiB record limit: under
 * 64 KiB when no entry is larger, as a step with one tool result is once the result fits its
 * 32 KiB cap (R2b C11). An entry larger than this is an event of its own.
 */
export const CHUNK_BYTES = 48 * 1024;

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

/**
 * The edits from `before` to `after`, split into chunks of at most `CHUNK_BYTES` of entries.
 * Empty when nothing changed.
 */
export function transcriptUpdates(
  before: readonly unknown[],
  after: readonly unknown[],
  chunkBytes = CHUNK_BYTES
): TranscriptUpdate[] {
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
    const size = JSON.stringify(entry).length;
    if (chunk.length > 0 && bytes + size > chunkBytes) flush();
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
