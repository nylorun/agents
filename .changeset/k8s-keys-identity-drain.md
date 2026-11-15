---
"@nylorun/runtime": patch
---

Computers on Kubernetes, the rest of the plan: the Helm chart signs Restate's requests to the
worker with an identity key it keeps (the runtime reads it from `NYLORUN_RESTATE_IDENTITY_KEY_FILE`,
a PEM it derives `publickeyv1_…` from), writes Restate's partition snapshots to the object store,
and can run the keys provider beside Substrate's egress (`keysProvider.enabled`) with the decide
route on the gateway. A computer resumed elsewhere by a drain records `agent.suspended` (reason
`drain`) on its next use, not only on its next reconcile.
