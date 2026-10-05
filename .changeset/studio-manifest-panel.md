---
"@nylorun/studio": minor
---

**Agent Manifest tab.** Each capability is a collapsible card with its type (plugins are marked), description, instructions (long text folds after a few lines), skills and hooks. Tools are grouped by where they run: your Action endpoint, subagents (flow subagents marked), and tools the engine adds for skills; a session with a sandbox also lists the six sandbox tools. Each tool expands to its input and output fields from its schemas. Hooks use the SDK names (`.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`) and list every capability registered on each point. The tab shows the manifest the session is pinned to, read from the Runtime's `GET /v1/sessions/{id}/manifest` when the Host offers `session-reads`, with a badge when a newer manifest is registered; on a Runtime without session reads it shows the registered manifest and says it cannot confirm the session's version. The Studio proxy now forwards that one read.
