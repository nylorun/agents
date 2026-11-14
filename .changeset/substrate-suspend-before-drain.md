---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": patch
---

Pods on Agent Substrate (preview): suspend before drain, following Substrate's eviction contract. A worker pod that stops (a drain, a GKE node upgrade or scale-down, a WorkerPool rollout, a deleted pod) sends each of its actors SIGTERM and gives them 30 minutes to be suspended; until now the engine exited on that signal, so the actor crashed and went back to its last suspend, losing everything since.

- `@nylorun/runtime`: on Substrate (`NYLORUN_SANDBOX_SUBSTRATE=1`, which the sandboxes service's template sets), the engine logs `harness_worker_stopping` on SIGTERM and keeps running, with its runs. The sandboxes service watches worker pods (label `ate.dev/worker-pool`) and, when one turns Terminating, suspends each of the Tenant's actors on it synchronously (eight at a time, trying again for up to 29 minutes), records `drainedAt`, and resumes a sandbox whose request is `Running` on another worker. While it moves, its status reason is `Moving`, and the pod lifecycle waits instead of failing it at the ready deadline. Each drain is recorded once, as `agent.suspended` with reason `drain` (the pod row's `drained_at`, store migration 0048, nullable, run at start). Not covered: a spot reclaim or a node that dies, which still crash and revert. An actor created by an earlier release keeps its engine (#643) until it is reset.
- `@nylorun/core`: `agent.suspended`'s `reason` may be `drain`.
- `nylorun`: `local sandbox enable --backend substrate` lets the sandboxes service read pods cluster-wide (`get`, `list`, `watch`), for the worker pods it watches.
