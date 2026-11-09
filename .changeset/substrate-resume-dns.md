---
"@nylorun/runtime": patch
---

Pods on Agent Substrate (preview): a pod's first start on a node that lacks its image no longer fails. The sandboxes service tries a resume that times out or finds Substrate busy again, every 5 s for up to 10 minutes while the pod should still be running; before, the first resume gave up after 2 minutes during a long image pull and the actor stayed RESUMING. Actors also get `RES_OPTIONS=timeout:1 attempts:3`, so a wake whose first DNS lookup of the edge is lost waits about 1 s instead of 5 s (an Agent's own `RES_OPTIONS` wins).
