---
"@nylorun/runtime": patch
---

Pods on Agent Substrate (preview): a drain is recorded as soon as the moved pod's engine connects again. After suspend before drain, the restored engine redials with its host token (no join), and nothing asked the Runtime to reconcile the pod, so `agent.suspended` with reason `drain` waited for the next turn or idle timer (E13 on kind: not within two minutes). A pod engine's connection now asks for its sandbox's reconcile.
