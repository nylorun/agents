---
"nylorun": patch
---

`nylorun local sandbox enable` waits for a newly installed agent-sandbox CRD by polling its `Established` condition. It used `kubectl wait --for=condition=Established`, which fails at once, with ".status.conditions accessor error", when the API server has not yet given the CRD any conditions; GKE answers that way right after the apply.
