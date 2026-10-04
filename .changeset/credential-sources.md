---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": minor
"@nylorun/studio": minor
---

**Installation vaults and a credential resolver (F9 C1).** A session's MCP credential now comes from its attached vaults, then from the operator's own credential resolver; nothing changes for existing vaults, and the protocol stays at 6.

- Installation vaults: `POST /v1/vaults` takes `scope: "installation"` (no `ownerUserId`) from an application key acting for no one; a request acting for a subject gets `403`. The vault is owned by `installation`, now a reserved subject like `host`. Any session may attach one and select its credentials. `GET /v1/vaults` from an application key lists them after the named person's vaults, and lists only them without `ownerUserId`; a request acting for a subject never sees one (the opaque `404`). The host model vault stays hidden and unattachable. Migration 0008 adds the scope.
- The credential resolver: `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the gateway (`TenantConfig.resolver` and `startEphemeralRuntime({ resolver })` in process). When the session's vaults hold nothing for a remote MCP server's URL, the Runtime POSTs `{ owner, session, turn, target: { kind: "mcp", server, agent, url } }` with the resolver's bearer: `200 { headers, expiresAt? }` is used, `404` goes without a credential, and anything else or no answer within 5 s refuses the server with `credential_unavailable`. Owner and turn come from the session row. Answers are cached per owner and URL until `expiresAt`, at most 5 minutes (60 s without one), and concurrent misses share one request. See DEPLOYMENT.md, Credentials.
- `nylorun`: the gateway's Compose service passes `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` from the shell that runs `nylorun start` (unset by default).
- Studio: the Vault page is now **Connections**, and creates installation vaults.
