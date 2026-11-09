---
"nylorun": minor
"@nylorun/runtime": minor
---

Pods on Agent Substrate (preview, ADR-138 Phase 1a). `nylorun local sandbox enable --context <name> --backend substrate` runs the Tenant's sandboxes as Agent Substrate v1.0 actors instead of agent-sandbox Sandboxes, on a Kubernetes 1.37 cluster with Substrate installed (Docker Desktop's kind cluster, or Substrate's own kind script). It creates the Tenant's namespace and the sandboxes service's RBAC, makes the Tenant's atespace with the service as its editor, gives actors a name for the edge in CoreDNS, and publishes the edge's two ports from the `sandboxes` service: a TLS front, in that container, through which actors reach the Harness API and the gates. The default backend stays agent-sandbox, and nothing changes for a Tenant that does not pass `--backend substrate`.

The sandboxes service drives Substrate's API: a template per pod incarnation, pinned by digest; an egress policy from the Agent's network (its preset, hosts and suffixes, which the core now sends with each pod); suspend and resume for `mode`; and the same `/v1/pods` contract, so the core is unchanged. Not yet on Substrate: keys injected at egress, builds and tags; those come in Phase 1b.
