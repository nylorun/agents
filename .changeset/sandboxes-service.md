---
"@nylorun/runtime": minor
"nylorun": minor
---

**The sandboxes service and `nylorun sandbox enable` (F7.2, first part).** A new image, `ghcr.io/nylorun/sandboxes`, versioned with the Runtime, drives agent-sandbox v1.0.5 Sandboxes in one namespace per Tenant: `PUT`, `GET ?wait=` and `DELETE /v1/pods/{name}` with an operation id, `/ready` and `/v1/info`, behind a bearer token only the runtime container holds. `nylorun sandbox enable --context <name>` installs into that kubeconfig context only (the pinned controller when absent, the namespace `nylorun-sbx-<tenant>`, a ServiceAccount whose Role covers Sandbox lifecycle and join Secrets, no NetworkPolicy or exec rights), refuses a cluster whose NetworkPolicy it cannot prove enforced, records `<Host root>/sandboxes/cluster.json` and the token, and adds the `sandboxes` service to the Tenant; `nylorun sandbox disable` and `nylorun sandbox status` remove and report it. Sessions do not run in pods yet: that comes with the Harness API and egress-gate.
