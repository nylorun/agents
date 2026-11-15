---
"@nylorun/runtime": minor
---

The Runtime's Helm chart, `charts/nylorun-runtime` (ADR-147, the Runtime on Kubernetes plan): the Runtime on an Agent Substrate cluster, with computers. It installs core, the gateway, the harness, Studio, the sandboxes service in the cluster, the sandbox gateway (atenet-router's client), Restate on a disk and s2-lite with its streams in the object store; Postgres and the object store are an external URL and S3 endpoint, or bundled (Postgres, RustFS). It makes the Runtime's secrets once and keeps them, and optionally pre-pulls images on worker nodes and makes the Tenant's atespace. Its README says what Substrate needs (the router's allowlist, the atespace) and has a GCP example.
