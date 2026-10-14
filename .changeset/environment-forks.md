---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

**Forks: how an Environment gets a new manifest version (Q15, Q17).** `POST /v1/environments/{id}/fork` makes a new Environment `id` from a manifest version (default the source's manifest at its latest), its disk started from a version of the source's (`disk`: `latest`, the default, snapshots first; a version; or `empty`) and the secrets the new manifest declares copied inside the Runtime (`secrets: "none"` copies none): each value is unsealed and sealed again under the new vault, with the slot's binding. The source keeps what it runs, its disk and its sessions, and gets `environment.forked`; the new Environment's view has `forkedFrom`. `dryRun: true` answers the plan: the disk, the secrets copied and left behind, required slots still missing, the changes and the sessions that stay. Migration 0026.

- **Setup on a forked disk.** A pod fork onto other setup runs the new version's setup on the copied disk before its first turn: the engine connects first (the join answer's `afterSeed`), core writes the disk version through it, then the engine runs the setup, and turns wait until it reports it done. A fork onto the same setup, a restore and a lost-volume recovery skip it, as before.
- `@nylorun/core`: `ForkEnvironmentRequestSchema`, `EnvironmentForkPlanSchema`, `ForkEnvironmentResponseSchema`, `EnvironmentView.forkedFrom`, the `environment.forked` event and `forkedFrom` on `environment.created`.
- `@nylorun/agents`: `client.environments.fork(id, { id, manifest?, disk?, secrets?, labels?, ownerUserId? })` and `planFork()`.
