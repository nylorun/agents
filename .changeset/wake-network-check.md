---
"@nylorun/runtime": patch
---

A pod's engine checks its NetworkPolicy quickly on a wake. When the pod's disk already holds the engine's volume id, one 150 ms probe of the API server (`harness.wakeNetworkProbeMs`, `harness.wakeNetworkConfirmations`) replaces three of a second, so a woken computer joins about 2.9 s sooner. A first start keeps the full check, and a wake whose probe connects goes back to it.
