---
"@nylorun/studio": minor
"@nylorun/agents": minor
---

**Studio shows an Environment's connections (D67).** The Environment page's Events tab filters all events, its lifecycle, or the connections its sandbox opened, each with its host, outcome, bytes and the turns that were running. A session's Environment tab lists the connections a pod Environment opened while that session's turns ran, and names the other sessions whose turns ran too, since a connection is the Environment's. `@nylorun/agents` exports `ENVIRONMENT_EVENT_TYPES` and the types `EnvironmentEventType` and `EgressRunningTurn`.
