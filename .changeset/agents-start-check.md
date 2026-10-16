---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

Track T3, the next start and its check: a pod Agent's start on a new version is checked until the new pod's harness joins (`startCheck` on the Agent). A failed setup, a failed pod, or a start slower than the Host's `tenant.upgradeStartMs` (10 minutes) takes the Agent back to the version it ran, its definition and not its disk, records `agent.start_failed`, and names the version `failedVersion` (state `failing`), which a tracking Agent does not move to again. A new version's setup runs on the same volume when its commands or files changed (`setupHash` in the setup plan and the volume's marker). While a pod waits to start on a new version it idles at most `tenant.upgradeIdleMs` (1 minute). `POST /v1/agents/{id}/restart` applies a pending version now; `retry: true` tries the failed version again.
