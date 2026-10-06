---
"@nylorun/core": major
"@nylorun/runtime": major
"@nylorun/agents": major
"@nylorun/cli": major
"@nylorun/admin": minor
---

**Protocol 9: the Runtime API is an OAuth 2.1 resource server for your identity provider's tokens.** Nylorun is still never the authorization server. Upgrade every package together; MIGRATION.md has the details.

- **Breaking (`@nylorun/runtime`): a refused credential is `401`, not the opaque `404`.** No `Authorization` is `401 credential_required`; an unknown key, or a token no trusted issuer signed or that fails a check, is `401 credential_invalid`. Each carries `WWW-Authenticate: Bearer` (OAuth 2.1 §5.3), naming the protected resource metadata (`resource_metadata`) on the Runtime API when the Runtime has trusted issuers; the Management API's challenge is a bare `Bearer`. `token_expired` and `issuer_unavailable` gain the challenge too. Another Tenant named, a Tenant that could not open and an unsigned capability link stay the opaque `404`.
- **Breaking (`@nylorun/runtime`): a request with neither `Nylorun-Protocol` nor `Authorization`** on an API route gets that route's `401` challenge instead of `426`, so a generic OAuth client learns where to sign in.
- `@nylorun/runtime`: a token without a route's scope still gets `403 scope_required`, now with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. The `Bearer` scheme is matched in any case (RFC 9110).
- `@nylorun/runtime`: `GET /.well-known/oauth-protected-resource` (RFC 9728) serves the resource (`NYLORUN_PUBLIC_URL`, else the request's origin), the identity file's issuers in order and their scopes, with no key or protocol; `404` without an identity file.
- **Breaking (`@nylorun/runtime`): the identity file drops `maxLifetime`.** The issuer sets its tokens' lifetimes; `exp` is required, `iat` no longer is. A key the file does not define, `maxLifetime` included, is ignored and logged (`identity_file_key_ignored`) instead of stopping the boot. `subject` defaults to `{sub}`, `scopes` to `{ claim: scope }` and `allowedScopes` to every token scope but `studio`.
- `@nylorun/core`: `PROTOCOL_VERSION` is 9 and `HOST_PROTOCOL` 4–9, with the required feature `resource-server`; `ERROR_CODES` adds `credential_required` and `credential_invalid`. `@nylorun/agents`, `@nylorun/admin` and `@nylorun/cli` send protocol 9.
