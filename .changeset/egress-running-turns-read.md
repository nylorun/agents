---
"@nylorun/runtime": patch
---

egress-gate's `environment.egress` names the turns its one read saw as the connection opened: the read starts as the name resolves and the tunnel never waits for it, as the docs now say. The egress-gate event test waits for that read before it moves a turn, so it no longer fails on a slow runner.
