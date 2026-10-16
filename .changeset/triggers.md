---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/admin": patch
"nylorun": minor
---

Triggers (track T4, D74). An agent manifest's `runtime.triggers` declares `schedule` (cron with an IANA `timezone`) and `at` triggers, each with the session its runs go to (a session id, opened on the first run, or `new` for a session per run) and its prompt. They start active with a new Agent, fire on a durable timer per trigger with Postgres as the truth (one late fire after downtime, never a backfill, a fixed jitter per trigger), and each fire is a run (`started`, `queued`, `skipped` or `failed`, with a reason) at `GET /v1/agents/{id}/runs`. A schedule adds at most one queued message to a busy session. `GET /v1/agents/{id}/triggers` and `POST .../triggers/{triggerId}/pause`, `/resume` and `/run` (with an `Idempotency-Key`); Agent reads add `nextWakeAt`, and the Agent's stream adds `agent.run`, `agent.trigger_paused` and `agent.trigger_resumed`. New Runtime limits: `triggersPerAgent`, `triggerMinIntervalMs` and `triggerRunRetentionMs` (with floors), `triggerRunsPerHour`, `triggerJitterPercent`, `triggerJitterMaxMs`, `triggerPromptChars`; Host tuning `triggers.lateGraceMs` and `triggers.intervalCheckFires`. The SDK's `client.agents` adds `triggers`, `pauseTrigger`, `resumeTrigger`, `runTrigger` and `runs`; the CLI adds `nylorun agents triggers` and `nylorun agents runs`.
