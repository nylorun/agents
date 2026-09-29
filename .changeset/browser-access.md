---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/cli": minor
---

**Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

- **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
- **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
- **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
- **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
- **CLI.** `nylo access keys list|create|set-origins|revoke`.
