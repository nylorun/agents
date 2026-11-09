---
"@nylorun/runtime": patch
---

Pods on Agent Substrate (preview): `nylorun local sandbox enable --backend substrate` no longer fails at the Tenant's atespace (`access_policy.metadata.atespace: Forbidden: must not be set`), and a pod that ran before wakes again instead of failing every later apply with `name: Required value`. The sandboxes service now writes the atespace's access policy without an atespace, as Substrate v1.0 requires of a global-scoped policy, and names the actor's egress policy (`default`) when it reads it back.
