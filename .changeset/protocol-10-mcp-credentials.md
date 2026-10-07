---
"@nylorun/core": major
"@nylorun/runtime": major
"@nylorun/agents": major
"@nylorun/admin": major
"@nylorun/cli": major
"nylorun": major
"@nylorun/studio": patch
---

**Protocol 10: MCP credentials come from a session's vaults only.** Nylorun no longer signs the installation in to MCP servers with OAuth and no longer asks a credential resolver. Upgrade every package together; MIGRATION.md has the details.

- **Breaking (`@nylorun/runtime`): the MCP OAuth connect is gone.** `POST /v1/tenant/vaults/{vaultId}/oauth/start` and `GET /v1/oauth/callback` answer `404`. The vault credential type `oauth` and its refresh are gone: a credential is a `bearer` token or a `headers` map bound to a URL. Migration `0016_mcp_oauth_removed` drops the table of pending connects and deletes every `oauth` credential, writing one audit row each (actor `migration`); the Runtime logs `oauth_credential_removed` once for each, naming its vault, id and URL.
- **Breaking (`@nylorun/runtime`): the credential resolver is gone.** The gateway no longer asks the operator's resolver for a person's credential when the session's vaults hold none. A process that still sets a `NYLORUN_RESOLVER_*` variable logs `resolver_removed` and ignores it. Keep a person's own keys in their user vault and attach it to their sessions (`vaultIds`). `TenantConfig.resolver`, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` export and `VaultService`'s `fetch` option are removed; `NYLORUN_PUBLIC_URL` still sets the protected resource metadata's `resource`.
- **Breaking (`@nylorun/core`):** `PROTOCOL_VERSION` is 10 and `HOST_PROTOCOL` 4–10. `StartOAuthRequest`, `StartOAuthResponse`, the `oauth` variants of `CreateCredentialRequest` and `RotateCredentialRequest`, `oauth` in `CredentialInfo.type` and `CredentialInfo.expiresAt` are removed, and `ERROR_CODES` drops `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`. `@nylorun/agents` and `@nylorun/cli` send protocol 10.
- **Breaking (`@nylorun/admin`):** `admin.vaults` loses its OAuth start method.
- **Breaking (`nylorun`):** the `connect` subcommand of `nylorun mcp` is removed (`nylorun mcp inspect` lists a server's tools instead), and the gateway's Compose service no longer passes the `NYLORUN_RESOLVER_*` variables.
- `@nylorun/studio`: the Credentials page loses the OAuth type, the Expires column and the OAuth connect hint.
