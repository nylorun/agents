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
 *   (`leanState`). The advance (`harness-api/start.ts`) folds the record from `Session.history.from` and hands the
 *   engine the full transcript (`withTranscript`).
 * - **Shadow mode** (on in the runtime's tests, `test/setup/transcript-shadow.ts`) keeps the
 *   transcript on the row too and checks the fold against it at every segment start.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import { applyUpdate, transcriptOf, type TranscriptUpdate } from "@nylorun/core/harness-api";

export {
  CHUNK_BYTES,
  TranscriptFoldError,
  applyUpdate,
  applyUpdates,
  transcriptOf,
  transcriptUpdates,
  withTranscript,
  type TranscriptUpdate,
} from "@nylorun/core/harness-api";

/** Where a session's fold starts. */
export interface SessionHistory {
  /** The fold reads the record from this seq: a snapshot at or before the turn's start. */
  from: number;
  /** The latest snapshot (`keep: 0`), which `from` moves to when the next turn starts. */
  snapshot?: number;
}

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

/**
 * Folds a session's events, from the start of its record or from a snapshot, into the
 * transcript the engine resumes from.
 */
export function foldTranscript(events: Iterable<Pick<LiveEvent, "type" | "turnId" | "payload">>): unknown[] {
  return foldTranscriptWithCursor(events).transcript;
}

/**
 * `foldTranscript`, and the cursor of the fold: the `seq` of the last event that changed it
 * (`transcript.updated`, `turn.cancelled`, `turn.failed`), or -1. A harness that holds the
 * transcript at the same cursor holds this one.
 */
export function foldTranscriptWithCursor(
  events: Iterable<Pick<LiveEvent, "type" | "turnId" | "payload"> & { seq?: number }>
): { transcript: unknown[]; cursor: number } {
  let transcript: unknown[] = [];
  let cursor = -1;
  // The transcript before the current turn's first edit: what a cancel or failure restores.
  let turn: { id: string | null; before: unknown[] } | undefined;
  for (const event of events) {
    if (event.type === "transcript.updated") {
      if (!turn || turn.id !== event.turnId) turn = { id: event.turnId, before: transcript };
      transcript = applyUpdate(transcript, event.payload as TranscriptUpdate);
      cursor = event.seq ?? cursor;
    } else if (event.type === "turn.cancelled" || event.type === "turn.failed") {
      if (turn && turn.id === event.turnId) transcript = turn.before;
      turn = undefined;
      cursor = event.seq ?? cursor;
    } else if (event.type === "turn.completed") turn = undefined;
  }
  return { transcript, cursor };
}

/** `state` with an empty transcript (what the session row stores outside shadow mode). */
export function leanState<T>(state: T): T {
  if (shadow || !state || transcriptOf(state).length === 0) return state;
  return { ...state, transcript: [] };
}

/** In shadow mode, checks the fold against the transcript the row kept. */
export function checkParity(sessionId: string, folded: readonly unknown[], stored: readonly unknown[]): void {
  if (!shadow) return;
  const length = Math.max(folded.length, stored.length);
  for (let i = 0; i < length; i += 1)
    if (!same(folded[i], stored[i]))
      throw new TranscriptParityError(sessionId, i, folded.length, stored.length);
}
