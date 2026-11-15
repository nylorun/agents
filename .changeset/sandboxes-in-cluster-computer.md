---
"@nylorun/runtime": minor
---

The sandboxes service runs in the cluster it drives, and Agent Substrate sandboxes can be computers (ADR-149, the Runtime on Kubernetes plan). `cluster.json`'s `inCluster: true` uses the pod's ServiceAccount and reaches Substrate's API by its Service with a projected token; `substrate.computer` renders every sandbox as a computer: its engine runs `--service computer`, with no join token, edge or edge rule, a wake-up probe on `/ready`, and the ticket key's public half. `sandboxes gateway` is the sandbox gateway (ADR-148): it checks a computer ticket and proxies to the computer through an mTLS CONNECT tunnel to `atenet-router`.
