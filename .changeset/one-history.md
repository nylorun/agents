---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

**One history: a session's transcript is folded from its record.** The own loop's model-facing transcript is no longer stored on the session row, where up to three copies of it lived (`state`, `turnStartState` and the checkpoint). After each segment that keeps its state, the Runtime records the change as an internal `transcript.updated` event: the new entries, or a snapshot after compaction. Each segment folds the transcript back from the record, and a cancelled or failed turn's entries are undone, as before.

- **Internal events.** `transcript.updated` is in the event catalog with `visibility: "internal"`. SSE, history, AG-UI and A2A never serve it. Served events can therefore skip the seq numbers internal events hold; cursors resume as before. `TranscriptUpdatedPayloadSchema` is exported from `@nylorun/core/contracts`, and catalog entries may declare `visibility`.
- **No checkpoints table.** Every settle used to write a copy of the session's checkpoint to a `checkpoints` table that nothing read; it is gone. The checkpoint a session resumes from stays on the session row.
- **Storage.** A long session's row no longer grows with its transcript (a 10-turn, 300-step session on a 16k window: under 16 KB instead of up to 196 KB).
