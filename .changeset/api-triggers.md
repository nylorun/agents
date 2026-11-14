---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"nylorun": minor
"@nylorun/studio": minor
---

A client can give one Agent a trigger over the API (D88, ADR-145; Host feature `api-triggers`). `PUT /v1/agents/{agentId}/triggers/{triggerId}` creates or replaces the Agent's trigger of a fourth origin, `api`: the body is a `Trigger` exactly as a definition's `runtime.triggers` entry holds it (one of `schedule` with `timezone`, `at` or `webhook`; `session`; `prompt`) and an optional `title`. A new one is active with its next time; a replaced one gets its next time again and keeps its status; the same body again changes nothing and records no event. An id the definition declares, or one an agent's trigger or a booked wake holds, is `409 trigger_conflict`. The checks and limits are a definition's, and `runtime.limits.triggers.count` now counts the triggers an Agent's agents made and those clients put together (`422 trigger_limit`). Upgrades and moves never touch an `api` trigger, `DELETE` removes it, and pause, resume, run and a webhook's secret work as for any trigger.

- `@nylorun/core`: `TRIGGER_ORIGINS` adds `api`; `TriggerPutSchema`; `TriggerView.principal`; `agent.trigger_created` and `agent.trigger_updated` carry `origin`, `principal`, the timing and `changed` (their `sessionId` is now optional, set for `agent` only; `kind` adds `webhook`), and `agent.trigger_deleted` carries `origin`; Host feature `api-triggers`.
- `@nylorun/runtime`: the route; `agent_triggers.principal` and the `api` origin (store migration 0049, run at start).
- `@nylorun/agents`: `agents.putTrigger(agentId, triggerId, trigger)`; `deleteTrigger` deletes `api` triggers too.
- `nylorun`: `nylorun agents triggers put <id> <trigger>` with `--schedule`, `--timezone`, `--at`, `--webhook`, `--session`, `--prompt` and `--title`, or a JSON file; `rm` deletes `api` triggers.
- `@nylorun/studio`: the Triggers tab shows where each trigger came from (the definition's version, the agent that made it, or the principal that put it), its prompt and time zone for every origin, and deletes one an agent made or a client put; Activity words trigger changes and filters them.
