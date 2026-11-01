---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

The memory index a session pinned is refreshed at its next turn's first segment (never mid-turn)
when another session of the Agent, or the API, wrote the Agent's memory since its last turn started:
`turn.start.memory.refresh` (Harness API), and our engine pins the index again (`runDurable`'s
`refreshPinned`). The Runtime keeps the newest memory version a turn saw on the session
(`Session.memoryIndex`, `memoryWritesSince`). A session's own writes leave its index as pinned.
