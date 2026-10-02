---
"@nylorun/runtime": patch
---

**Migration 9 drops the unused `checkpoints` table.** Every settle wrote a copy of the session's checkpoint to it, and nothing read it; the checkpoint a session resumes from stays on the session row. No action is needed. Drain a Runtime before upgrading it, as for any migration: an older Runtime still running against the migrated schema would fail when it tries to write the table.
