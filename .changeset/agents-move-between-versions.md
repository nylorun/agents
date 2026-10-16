---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": patch
---

Track T3, Agents that evolve: an Agent moves between versions of its manifest in place, with its id, disk, vault and sessions. `PUT /v1/agents/{id}` with another version moves it (`?dryRun=true` answers the plan, `AgentMovePlan`), and saving a manifest moves every Agent that tracks it. A harness-only change applies at once; a runtime change a pod applies only when it starts (image, resources, network, setup, files) leaves the Agent outdated (`targetVersion`, `waitingFor: "start"`) until its pod's next start, on the same volume; a version that adds a required secret waits for its value (`waitingFor: "secrets"`, state `input_required`). Its manifest's name, kind, harness and storage are fixed: `409 agent_fixed_field` replaces `409 agent_upgrade_unavailable`. Only secrets that fill a slot of the running version are used; others stay in the vault, dormant. New events `agent.outdated` and `agent.version_changed`, `GET /v1/agents?outdated=true`, and the save plan's `moves` and `agents_move` warning. Migration 0033 adds the Agent's target and failed versions and its start check.
