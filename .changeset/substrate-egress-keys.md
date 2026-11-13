---
"@nylorun/runtime": minor
"nylorun": minor
---

Pods on Agent Substrate (preview): keys now reach commands through Substrate's own egress ([ADR-142](https://github.com/nylorun/factory/blob/main/decisions/platform/2026-11-13-substrate-egress-adds-keys.md)). A command sends its stand-in, with no proxy, and Substrate's egress replaces the header on each request to a host the Agent has a key for, so `curl`, `gh` and SDKs work against keyed hosts, over HTTP/2 too. A removed key now fails closed with 403 instead of sending the stand-in.

- Each host the Agent has an `environment_secret` or slot for, and each host its owner connected through the outside credential source, becomes an `https` rule in the actor's egress policy that names a reference, never a value.
- The keys provider (`sandboxes provider`, from the sandboxes image) runs beside Substrate's egress. For every keyed request it asks egress-gate's new decide route (`POST /nylorun/v1/egress/decide`, token `NYLORUN_EGRESS_KEYS_TOKEN`), which checks that the actor is the sandbox's current incarnation and returns the vault's header value. For a person's key it returns only who owns it, and the provider fetches the value from the outside source's new `/v1/fetch`.
- The outside credential source's `/v1/hosts` may name each host's header (`{ host, header }`); a plain host name still means `Authorization`.
- The engine on Substrate writes a trust bundle with Substrate's egress CA and names it in `SSL_CERT_FILE` and the other trust variables.
- `nylorun local sandbox enable --backend substrate` deploys the keys provider in `ate-system`, publishes the edge's keys port (8795 by default), and checks that Substrate's egress was installed asking it (`--credential-provider='[{"name":"keys.nylorun.dev","address":"nylorun-keys-provider.ate-system.svc:50051"}]'`). When it wasn't, keys stay off and `enable` says how to turn them on. `sandbox status` shows whether keys are on.
