---
"@nylorun/runtime": minor
"@nylorun/harness": patch
---

Track T3, versions per turn: a turn's first segment takes the manifest version its session's Agent runs then, so a session moves with its Agent between turns and keeps one version through every segment, approval and rollover of a turn. A turn whose message named a variant, and a flow's sessions, keep the version they pinned; a changed loop manifest drops the session's MCP snapshot. The turn span names the version (`nylorun.manifest.version`). Our engine takes a new version's output schema at the next turn.
