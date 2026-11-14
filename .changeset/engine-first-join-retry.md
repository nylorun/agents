---
"@nylorun/runtime": patch
---

Pods on Agent Substrate (preview): a pod's engine tries its first join again while the edge can't be reached. A new actor can start before its egress policy reaches Substrate's egress, so the first join failed at the network ("fetch failed") and the engine exited; Substrate doesn't restart an actor's main process, so the actor stayed RUNNING with no engine and the start failed at the ready deadline (E13 on kind: 2 of 3 first starts). The first join is now tried again from 250 ms, doubling to 5 s, for up to 4 minutes (`sandbox_join_retry` in the engine's log); a refusal is still final at once.
