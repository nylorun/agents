---
"@nylorun/core": minor
"@nylorun/runtime": minor
"nylorun": minor
---

**MCP OAuth connect for installation vaults (F9 C2).** The installation can sign in once to a remote MCP server that uses OAuth, and every session that attaches the vault uses the credential. Additive; the protocol stays at 6.

- `POST /v1/vaults/{vaultId}/oauth/start` (application keys acting for no one, installation vaults only) takes `{ url, server, clientId? }` and answers `{ authorizeUrl, expiresAt }`. The Runtime discovers the server's authorization server (RFC 9728, then RFC 8414), registers itself (RFC 7591) unless `clientId` names a registered client, and starts an S256 PKCE sign-in whose `state` works once, for ten minutes. A server without registration and no `clientId` is `400 oauth_client_required`.
- `GET /v1/oauth/callback` takes the browser back: anonymous and unversioned like an artifact link, it exchanges the code and stores an `oauth` credential bound to the URL, named after `server` (connecting again rotates it), and answers a small HTML page. An unknown, used or expired `state` is `oauth_state_invalid`; the authorization server's refusal is `oauth_failed`. The callback's base is `NYLORUN_PUBLIC_URL` (`TenantConfig.publicUrl`), else the start request's origin.
- Every OAuth step runs in the gateway's keys module (F9-D14): the runtime container never sees a token, the PKCE verifier or a client secret, and makes no outbound call. Migration 0009 adds `oauth_pending`, with the verifier and secret sealed under the vault key. `Keys` gains `startOAuth` and `finishOAuth`.
- OAuth requests, including refresh of every OAuth vault credential, now go through `guardedFetch` (`tenant/outbound.ts`): the `NYLORUN_ENDPOINT_*` address policy checked on the address connected to, no redirects, a bounded answer. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a token endpoint on a private address is refused, where refresh used to call it.
- `@nylorun/core`: `ERROR_CODES` adds `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`; `StartOAuthRequestSchema` and `StartOAuthResponseSchema`.
- `nylorun mcp connect <url> --server <name> [--vault <id>] [--client-id <id>]`: creates the installation vault `mcp` if needed, opens the sign-in page and waits up to 10 minutes for the credential. See DEPLOYMENT.md, "Connecting a remote MCP server with OAuth".
