---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": minor
---

An outside credential provider for the egress gate (Host feature `credential-provider`; no protocol change). A Host's operator names a service that holds people's keys with `NYLORUN_CREDENTIAL_PROVIDER_URL` and `NYLORUN_CREDENTIAL_PROVIDER_TOKEN`, which `nylorun start` passes from its shell to the `gateway` and `runtime` containers. For a pod Agent with an owner, egress-gate asks the provider (`POST /v1/hosts`, with the Agent and its owner) which hosts the owner connected, lets them through on 443 inside the Tenant's egress ceiling, terminates TLS for them and hands each request to `<url>/v1/forward/<path>` with the sandbox's own headers plus `nylorun-provider-host`, `nylorun-provider-agent`, `nylorun-provider-owner` and `nylorun-provider-token`; the provider adds the key and sends it on, so the Runtime never sees a value. Each segment's sandbox sees the variables the provider names (`POST /v1/environment`) as `nylorun_managed`, under the vault's own. A secret in the Agent's vault bound to the same host still wins. Answers are cached per Agent for 15 s (Host tuning `credentialProvider.*`); an Agent with no owner is never asked about, and a provider that fails answers nothing, so its hosts are refused as before.
