---
"@nylorun/agents": minor
"nylorun": minor
"@nylorun/studio": minor
"@nylorun/create-agent": patch
---

Track T3 in the clients. The SDK has `client.agents.plan(id, input)` (what a move would do), `client.agents.restart(id, { retry? })` and `list({ outdated: true })`. The CLI has `nylorun agents pin <id> <n>`, `track <id>`, `restart <id> [--retry]`, `put --dry-run`, and `list --outdated` (`--behind` kept as its alias), and prints the version an Agent moves to. Studio's Agent page moves an Agent (Move to vN, Pin, Track), restarts it on a pending version or retries a failed one, and shows "vN at next start", a version waiting for secrets, or one that failed to start. The starter's dev loop no longer deletes and remakes its Agent: the tracking Agent moves on each save.
