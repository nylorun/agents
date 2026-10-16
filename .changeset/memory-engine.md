---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": patch
---

Our engine offers the `memory` tool (track T5, D72). An agent whose version sets `harness.memory` gets one `memory` tool with Anthropic's memory tool schema (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`; `view` only for a `read_only` agent and an agent used as a tool), our memory rules followed by the agent's `instructions`, and its memory index pinned after the instructions as user-role context: kept for the session so the prompt prefix stays cacheable (`ExecutionState.pinned`), and re-pinned after a compaction. Each command's parameters are checked before a call is sent (`checkMemoryCall` in `@nylorun/core/contracts`, which the Runtime also uses), and a call named `memory.<command>` or `memory/<command>` runs as `memory` with that command (`memoryAliasOf`). `ModelRequest.pinned` carries the pinned text; `memoryTool` and `memoryIndexBlock` are exported for your own harness.
