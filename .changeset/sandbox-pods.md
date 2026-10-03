---
"@nylorun/runtime": minor
"@nylorun/core": minor
"nylorun": minor
---

**Pod sandboxes (F7.2, second part).** With `nylorun sandbox enable`, a sandbox resource of kind `pod` (`PUT /v1/sandboxes/{id}` with `kind: "pod"`, an `image`, `*.suffix` hosts, `storage` and `lifecycle.ttl`) is an agent-sandbox pod on the Tenant's cluster, created at once. The turns of the sessions attached to it run in the pod: the engine is copied from the Runtime image into the pod (the Runtime image now carries tini for it), waits until the pod's NetworkPolicy is in force, exchanges its join token for a host token at the Harness API listener (`POST /nylorun/harness/v1/host/join`, published for pods on the Docker host's address, with the gates), and serves its sandbox alone. New: `POST /v1/sandboxes/{id}/stop` and `/reset`; the Tenant's `limits.ttl`, `lifecycle.onExpiry`, `lifecycle.stopGrace` and `placement`; idle stop; lifecycle events `sandbox.running`, `.suspended`, `.expired`, `.relaunched`, `.lost`, `.reset` and `.failed`; error codes `placement_refused`, `sandbox_lost` and `sandbox_expired`; `cluster` in `GET /v1/tenant/sandbox`; Host feature `sandbox-pods` (additive, protocol unchanged). Without a cluster, kind `pod` is `409 sandbox_unavailable` (it was 400). Migration `0007_sandbox_pods` adds the pod lifecycle columns to `sandbox_resources`.
