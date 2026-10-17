---
"@nylorun/studio": minor
---

A session's inspector has four tabs, one per kind of data and the same for agent and workflow sessions: **Manifest** (what the agent is), **Record** (what the session holds), **Events** (what happened) and **Usage** (what it cost). Manifest's two views are **Declared**, the manifest the session pinned (the old Manifest tab, also for a workflow), and **Deployed**, where it runs (the old Agent tab). Record holds the session's files (the old Outputs tab). A workflow's Tree and Iterations tabs are Events' **Progress** and **Iterations** views, beside **Log**; a workflow session opens on Progress. `?view=` names a tab's view, and the old `?inspector=` values (`agent`, `environment`, `artifacts`, `tree`, `iterations`) still open their place.
