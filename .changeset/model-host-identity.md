---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": minor
---

A model can use the Host's own identity (ADR-71, Host feature `model-host-identity`). `PUT /v1/tenant/model` takes `auth: { type: "host_identity", project, location }` for `google-vertex`. It keeps no secret, and the model gate calls Agent Platform with the Host's Google Application Default Credentials: on Google Cloud, the attached service account from the metadata server. It's off unless the operator lists the provider in `NYLORUN_MODEL_HOST_IDENTITY` on the process that runs the gates, which `nylorun start` passes from its shell to the `gateway` container. Every Tenant on that Host may use it. `nylorun tenant models set --provider google-vertex --model <id> --host-identity --project <id> --location <location>` sets it with no key.
