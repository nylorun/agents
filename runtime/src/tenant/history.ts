/**
 * One history (blueprint P0.3): the own loop's model-facing transcript is a fold of the
 * session's record, not a copy on the session row.
 *
 * - **Write.** After a segment that keeps the engine's state (a rollover, or a settle that is
 *   not a failure), the Runtime appends `transcript.updated` events: an edit from the
 *   transcript the segment started with to the one the engine returned (`transcriptUpdates`).
 *   Normal steps only append; compaction replaces the prefix, so its edit is a snapshot.
 * - **Fold.** `foldTranscript` applies the edits in order. `turn.cancelled` and `turn.failed`
 *   restore the transcript from before that turn's first edit, as cancel and failure restore
 *   `turnStartState`.
 * - **Lean rows.** The session row stores the engine state with an empty transcript
 *   (`leanState`). `runSegment` folds the record from `Session.history.from` and hands the
 *   engine the full transcript (`withTranscript`).
 * - **Shadow mode** (on in the runtime's tests, `test/setup/transcript-shadow.ts`) keeps the
 *   transcript on the row too and checks the fold against it at every segment start.
 */
import type { LiveEvent } from "@nylorun/core/contracts";

/** The payload of one `transcript.updated` event. */
export interface TranscriptUpdate {
  keep: number;
  entries: unknown[];
  length: number;
}

/** Where a session's fold starts. */
export interface SessionHistory {
  /** The fold reads the record from this seq: a snapshot at or before the turn's start. */
  from: number;
  /** The latest snapshot (`keep: 0`), which `from` moves to when the next turn starts. */
  snapshot?: number;
}

/** An edit's entries are split so each event stays well under S2's 1 MiB record limit. */
export const CHUNK_BYTES = 256 * 1024;

let shadow = false;
/** Shadow mode: keep the transcript on the session row and check the fold against it. */
export function transcriptShadow(): boolean {
  return shadow;
}
/** Tests switch shadow mode off to exercise lean rows. Returns the previous setting. */
export function setTranscriptShadow(on: boolean): boolean {
  const previous = shadow;
  shadow = on;
  return previous;
}

export class TranscriptFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptFoldError";
  }
}

/** The fold and the transcript on the row differ (shadow mode only). */
export class TranscriptParityError extends Error {
  constructor(sessionId: string, at: number, folded: number, stored: number) {
    super(
      `Session ${sessionId}: the folded transcript differs from the stored one at entry ${at}` +
        ` (folded ${folded} entries, stored ${stored})`
    );
    this.name = "TranscriptParityError";
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The engine state's transcript, or none. */
export function transcriptOf(state: unknown): unknown[] {
  const transcript = (state as { transcript?: unknown } | undefined)?.transcript;
  return Array.isArray(transcript) ? transcript : [];
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

/**
 * Folds a session's events, from the start of its record or from a snapshot, into the
 * transcript the engine resumes from.
 */
export function foldTranscript(events: Iterable<Pick<LiveEvent, "type" | "turnId" | "payload">>): unknown[] {
  let transcript: unknown[] = [];
  // The transcript before the current turn's first edit: what a cancel or failure restores.
  let turn: { id: string | null; before: unknown[] } | undefined;
  for (const event of events) {
    if (event.type === "transcript.updated") {
      if (!turn || turn.id !== event.turnId) turn = { id: event.turnId, before: transcript };
      transcript = applyUpdate(transcript, event.payload as TranscriptUpdate);
    } else if (event.type === "turn.cancelled" || event.type === "turn.failed") {
      if (turn && turn.id === event.turnId) transcript = turn.before;
      turn = undefined;
    } else if (event.type === "turn.completed") turn = undefined;
  }
  return transcript;
}

/** `state` with an empty transcript (what the session row stores outside shadow mode). */
export function leanState<T>(state: T): T {
  if (shadow || !state || transcriptOf(state).length === 0) return state;
  return { ...state, transcript: [] };
}

/** `state` with `transcript` (what the engine runs on). */
export function withTranscript<T>(state: T, transcript: readonly unknown[]): T {
  if (!state) return state;
  return { ...state, transcript: [...transcript] };
}

/** In shadow mode, checks the fold against the transcript the row kept. */
export function checkParity(sessionId: string, folded: readonly unknown[], stored: readonly unknown[]): void {
  if (!shadow) return;
  const length = Math.max(folded.length, stored.length);
  for (let i = 0; i < length; i += 1)
    if (!same(folded[i], stored[i]))
      throw new TranscriptParityError(sessionId, i, folded.length, stored.length);
}
