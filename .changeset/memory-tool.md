---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

The `memory` tool's calls (track T5, D72). A new effect target, `{kind: "runtime", operation: "memory"}` (additive on Harness API 5), carries Anthropic's memory tool input (`command`: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`, and its parameters); core serves it in the intent's own transaction, so a replayed turn applies a write once. A malformed call fails with text for the model and changes nothing; a write from a `read_only` agent or a sub-agent is `memory.forbidden`. Each write is a memory version naming the turn's manifest version, session, turn and the trigger run that started the turn, with a new session event `memory.updated` and Agent event `agent.memory_updated`. `turn.start.memory` (`TurnMemorySchema`) carries the Agent's memory access, instructions and the index a harness pins, newest first, within the new Runtime limits `memoryIndexLines` (200) and `memoryIndexBytes` (25 KiB).
