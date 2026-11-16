---
"@nylorun/runtime": patch
---

The Helm chart takes `extraEnv.runtime`, `.gateway` and `.harness` (env entries, values or Secret
references) for the Runtime settings it doesn't set, a `serviceAccount.annotations` for the runtime's,
gateway's and harness's new ServiceAccount (`<name>-runtime`, no API token: GKE Workload Identity for
a model on the host's identity), and `service.type`, `.annotations` and `.loadBalancerSourceRanges`
for the runtime's Service (a cloud load balancer behind your own proxy), and `hostAliases` for those
pods.
