---
"@nylorun/runtime": patch
---

A pod's engine rejoins at once after an Agent Substrate restore. When the process resumes from a memory snapshot, the engine notices the jump in the wall clock (a 100 ms timer finding more than 1.5 s gone), drops the connection attempt the freeze caught in flight, its host-token renew or join included, and dials again without a backoff pause. Before, it waited for TCP to resend the packet lost with the old network: 1 s, or 3 s on a second loss, which the Phase 1 exit test measured in 4 of 10 wakes. Only pod engines watch for this (`harness_clock_jumped` in their log); an open connection is never dropped by it.
