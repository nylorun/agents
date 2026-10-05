# @nylorun/core

## 0.14.0-beta

### Major Changes

- 7f763c3: **The Admin API and the operator listener are gone (Runtime and Management APIs, step A5).** Host work moves to the machine: `nylorun` runs `nylorun-operate` inside the runtime container, and every remote client uses the Runtime API or the Management API.

  - **Breaking (`@nylorun/runtime`):** `/v1/admin/*` (status, host, shutdown, keys, openapi.json) is removed; it answers like any unknown route. The operator listener, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS` and `host.json`'s `adminPort` are gone, and so is the `admin-openapi.json` package file. Stop the Host with SIGTERM. `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name, state and cause, exiting 2 when the Tenant is not open. `/ready` adds `harness: { mode, connected }` while the Tenant is open. `startEphemeralRuntime` loses `operatorListener` and `adminUrl`. The admin key stays: it derives Studio's key.
  - **Breaking (`@nylorun/admin`):** `createAdmin()` is the Management API client (`tenant`, `keys`, `models`, `vaults`, `signingKeys`, `settings`) with a management key: explicit `{ url, key }`, else `NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`, else the Project link's or the local Host root's management key. `status()`, `adminUrl`, the Admin API keys, `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY` and `OPERATOR_KEYS_FEATURE` are removed; `deriveStudioToken` and `mintStudioLoginToken` stay.
  - **Breaking (`@nylorun/core`):** `admin-status` leaves `PROTOCOL_FEATURES` (the Host still advertises it for protocol 5–7 clients) and `operator-keys` is removed; `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema` and `HostShutdownResponseSchema` are removed.
  - **Breaking (`nylorun`):** no admin port: `NYLORUN_ADMIN_PORT` is no longer written or published (an existing one is ignored). `nylorun start` waits for `/ready`, and `nylorun status` reads readiness from `/ready` and the Tenant from `nylorun-operate status`.
  - `@nylorun/cli`: `nylo status` no longer falls back to the Admin API; when the Tenant does not answer it points to `npx nylorun status`.

- 98b0d37: **Protocol 8: the Runtime API and the Management API take separate keys (Runtime and Management APIs, step A4).** Upgrade every package together; `nylorun`, `@nylorun/cli` and Studio already use management keys (A3).

  - **Breaking (`@nylorun/runtime`): `/v1/tenant/*` takes only a management key.** An application key there, alone or acting for a subject, is `403 key_role_mismatch`; a management key acting for a subject is `403 subject_invalid`. This covers the Tenant's status, seed and reset, models, providers, usage and budgets, sandbox and artifact settings, application keys, vaults and signing keys. A management key on any other route but `/v1/me` and the public `/v1/access/jwks` is `403 key_role_mismatch`.
  - **Breaking (`@nylorun/runtime`): vaults and signing keys moved.** They are at `/v1/tenant/vaults…` (including `…/oauth/start`) and `/v1/tenant/signing-keys…`; `/v1/vaults…` and `/v1/access/signing-keys…` are gone, with no alias. Opening a session with `vaultIds` is unchanged, as are `GET /v1/oauth/callback` and `GET /v1/access/jwks`.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): `tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name it and it grants nothing. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit `agents:write` subjects: apps don't read the model catalog.
  - **Breaking (`@nylorun/agents`):** the vault methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`) and `client.access.signingKeys` / `SigningKeysClient` are removed; use `admin.vaults` and `admin.signingKeys` from `@nylorun/admin`'s `createManagementClient`. `client.access.jwks()` stays.
  - `@nylorun/core`: `PROTOCOL_VERSION` is 8 and `HOST_PROTOCOL` 4–8, with the required feature `management-api`. Runtime API routes keep their request and response shapes.
  - `@nylorun/runtime`: `startEphemeralRuntime` registers a management key (`managementKey`, the key `bootstrap`).

### Minor Changes

- 3b3bdc6: **The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

  - `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
  - `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
  - `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
  - **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
  - `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.

- 6576e12: **Key roles and management keys (Runtime and Management APIs, step A1).** Additive; the protocol stays at 7. Application keys keep reaching every route they reach today.

  - `@nylorun/runtime`: a key now has a role. `application` keys are unchanged. A new **management key** (role `management`) reaches the Management API (`/v1/tenant/*`) and `/v1/me` only, as itself: `Nylorun-Subject` or `Nylorun-Scopes` with it is `403 subject_invalid`, an `Origin` is `403 origin_rejected`, and any other route is `403 key_role_mismatch`. `/v1/me` reports it as `via: management:<id>` with no scopes and no agents. Studio's derived key has role `studio`, which reaches both. Migration `0011_key_roles` gives the existing `studio` principal its role.
  - `@nylorun/runtime`: management keys are issued only on the Tenant's machine, with the new `nylorun-operate` command in the runtime image (`nylorun-operate keys list | put <id> [--role application|management] | rm <id>`), or from `NYLORUN_MANAGEMENT_KEY_FILE` (64 hex characters), which the Host registers as the key `bootstrap` at every start and replaces when the file changes. `bootstrap` is reserved like `studio`. Rotating a key keeps its role; putting an id that holds the other role is refused.
  - `@nylorun/core`: `KEY_ROLES`, `KeyRole`, `BOOTSTRAP_KEY_ID` and the error code `key_role_mismatch`.

- b28bdd7: **Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
  - `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
  - `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
  - `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.

- c66d8ed: Add optional session reads and a resumable model-ledger export: pinned manifests, usage totals, model calls, and opt-in session/history/sandbox pages (Host feature `session-reads`), and `GET /v1/tenant/calls/model` on the Management API (Host feature `calls-export`). Usage and model calls take an application key acting as itself; the export takes a management key. Runtime reads use a separate bounded, read-only Drizzle pool. The additive migration `0012_session_reads` preserves unknown legacy creation times and usage quality; the export uses safe transaction order without skipping committed rows. `@nylorun/agents` adds `client.sessions.page()`, `session.manifest()`, `session.usage()`, `session.modelCalls()`, `session.history({ limit })` and `client.sandboxes.page()`; `@nylorun/admin` adds `models.exportCalls()`. Legacy unpaged responses are unchanged.

### Patch Changes

- cc107b1: **Named agents work as flow children.** An Agent with a `name` (for example `Agent({ id: "a", name: "Named A" })`) used in `.step()`, `.switch()`, `.parallel()`, `.map()`, `.loop()` or in `Chain`/`Switch`/`Parallel`/`Map`/`Loop` was mistaken for a tool, because a builder has a string `name` and an `.input()` method, and the build threw `tool.invalid: Tool 'Named A' must provide run() or execute()`. Agents, agent builders and flows are no longer classified as tools.

## 0.13.0-beta

### Major Changes

- bd478ee: **Subject tokens, browser keys and derived principals leave open source (F9 I3, protocol 7).** Upgrade these with the Runtime: they speak protocol 7, which this Runtime serves beside 4, 5 and 6; protocol 6 clients keep working on every route that remains. Browsers and apps present a trusted issuer's token (F9 I2), servers an operator key (F9 I1), and a person's own credentials come from the operator's credential resolver (F9 C1). See MIGRATION.md.

  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): subject tokens are gone.** `POST /v1/tokens`, `POST /v1/access/revocations`, subject-token verification, revocation epochs and the `subject.revoked` stream signal are removed; the routes answer `404`, and a JWT no trusted issuer signed is the opaque `404`. A stream opened with a token now ends only at its expiry (`event: nylorun.closed`, reason `token_expired`; `StreamClosedFrame` loses `revoked`). Migration `0010_oss_auth_removals` drops the `subject_epochs`, `subject_usage` and `publishable_keys` tables. The `token` caller is a trusted issuer's token only: it loses `role`, `limits` and `epoch`, and `issuer` is always set; `GET /v1/me` no longer reports `via: token`. Core drops `SUBJECT_TOKEN_TYPE`, `SUBJECT_TOKEN_AUDIENCE`, `subjectTokenIssuer` (the Runtime's own tokens use `tenantTokenIssuer`, same value), `CreateTokenRequest`/`Response`, `RevokeSubject*`, `SubjectTokenClaims`, `TOKEN_TTL_MIN_SECONDS` and `TOKEN_TTL_DEFAULT_SECONDS`; `TOKEN_SCOPES` is `agents:read`, `sessions:own`, `sandboxes:write`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): the access policy and role limits are gone.** `GET`/`PUT /v1/access/policy` answer `404`, a turn is never refused with `429 limit_exceeded` for a role (limit requests at your proxy), and an existing `access.policy` setting is ignored. Core drops `AccessPolicy*`, `AccessRole*`, `RoleLimits*`, `DEFAULT_ACCESS_POLICY`, `PutAccessPolicyRequest` and `ROLE_NAME_PATTERN`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`): publishable keys and the Runtime's CORS are gone.** `/v1/access/publishable-keys*` answer `404`, `Nylorun-Key` is ignored, `NYLORUN_BROWSER_ACCESS` and `browserAccess` (host.json, `createHost`, `startEphemeralRuntime`) are removed, and the Runtime sends no CORS headers. A request with `Origin` reaches the Tenant routes of the public listener with no toggle: a trusted issuer's token is served, an application key or delivery token is `403 origin_rejected`; admin routes, `/health`, `/ready` and the operator listener still refuse `Origin`. Any `OPTIONS` request is `204` with `Allow` and no CORS header: the operator's proxy answers preflights. Route declarations lose `browser` (`x-nylorun-browser` leaves the OpenAPI document) and the `publishable` credential; the token security scheme is `issuerToken`. Core drops `PUBLISHABLE_KEY_HEADER`, `PUBLISHABLE_KEY_PATTERN`, `PUBLISHABLE_KEY_ID_PATTERN`, `tenantOfPublishableKey`, `newPublishableKey`, `newPublishableKeyId`, `PublishableKey*`, `OriginEntrySchema`, `originAllowed` and `LOOPBACK_ORIGIN_WILDCARDS`.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`, `@nylorun/agents`): vault routes are application-only, and `vaults:own` is retired.** Every `/v1/vaults` route takes an application key acting for no one (operator keys, Studio); a request acting for a subject or a trusted issuer's token gets `403 scope_required`. `vaults:own` leaves `SUBJECT_SCOPES`, `TOKEN_SCOPES` and the issuer scopes; `Nylorun-Scopes` may still name it and it grants nothing. Existing user vaults stay attachable to their own owner's sessions. `client.createVault` takes `{ scope: "installation" }` or `ownerUserId`, and `client.listVaults()` takes an optional owner.
  - **Breaking (`@nylorun/runtime`, `@nylorun/core`, `@nylorun/admin`, `nylorun`): derived principals are gone.** Only Studio's key is derived from the admin key. `NYLORUN_DERIVED_PRINCIPALS` is ignored and no longer written, `hostPrincipals` takes no `derived`, `startEphemeralRuntime` no `derivedPrincipals`, and `@nylorun/admin` drops `deriveTenantKey`, `PROJECT_PRINCIPAL_ID` and `admin.deriveTenantKey`. Keys an earlier Host derived stay in the database and keep working as ordinary keys; replace them with operator keys. Core renames `DERIVED_PRINCIPAL_ID_PATTERN` to `APPLICATION_KEY_ID_PATTERN`.
  - **Breaking (`@nylorun/agents`):** `createTokenEndpoint`, `createBrowserClient` and the `@nylorun/agents/browser` entry, `client.tokens`, `TokensClient`, `PublishableKeysClient`, `client.access.getPolicy`/`putPolicy`/`revokeSubject`/`publishableKeys` and `Destination.publishableKey` are removed. `client.access.signingKeys` and `client.access.jwks()` stay, and `Destination.token` takes a trusted issuer's tokens.
  - **Breaking (`@nylorun/cli`):** `nylo access policy|keys|revoke|token` are removed and name what replaces them; `nylo access signing-keys list|rotate|revoke` stays.
  - **Breaking (`@nylorun/core`, `@nylorun/agents`, `@nylorun/studio`): the Studio embed message `open.babai` is now `open.session`** (`{ sessionId }`): it asks the embedding app to open that session in its own UI. Studio sends no such message itself.
  - **Breaking (`nylorun`): Studio embedding is opt-in.** No origin may frame Studio by default; list your app's origins with `nylorun start --studio-embed-origin <origin>`. A Tenant's `.env` from an earlier nylorun keeps the origins it had until `--studio-embed-origin-reset`.
  - `PROTOCOL_VERSION` is 7 and `HOST_PROTOCOL` 4–7; the Host features `subject-tokens`, `browser-access` and `derived-principals` are removed. `@nylorun/studio` and `@nylorun/create-agent` speak protocol 7.

### Minor Changes

- 8773586: **Installation vaults and a credential resolver (F9 C1).** A session's MCP credential now comes from its attached vaults, then from the operator's own credential resolver; nothing changes for existing vaults, and the protocol stays at 6.

  - Installation vaults: `POST /v1/vaults` takes `scope: "installation"` (no `ownerUserId`) from an application key acting for no one; a request acting for a subject gets `403`. The vault is owned by `installation`, now a reserved subject like `host`. Any session may attach one and select its credentials. `GET /v1/vaults` from an application key lists them after the named person's vaults, and lists only them without `ownerUserId`; a request acting for a subject never sees one (the opaque `404`). The host model vault stays hidden and unattachable. Migration 0008 adds the scope.
  - The credential resolver: `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the gateway (`TenantConfig.resolver` and `startEphemeralRuntime({ resolver })` in process). When the session's vaults hold nothing for a remote MCP server's URL, the Runtime POSTs `{ owner, session, turn, target: { kind: "mcp", server, agent, url } }` with the resolver's bearer: `200 { headers, expiresAt? }` is used, `404` goes without a credential, and anything else or no answer within 5 s refuses the server with `credential_unavailable`. Owner and turn come from the session row. Answers are cached per owner and URL until `expiresAt`, at most 5 minutes (60 s without one), and concurrent misses share one request. See DEPLOYMENT.md, Credentials.
  - `nylorun`: the gateway's Compose service passes `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` from the shell that runs `nylorun start` (unset by default).
  - Studio: the Vault page is now **Connections**, and creates installation vaults.

- e1bfb4b: **MCP OAuth connect for installation vaults (F9 C2).** The installation can sign in once to a remote MCP server that uses OAuth, and every session that attaches the vault uses the credential. Additive; the protocol stays at 6.

  - `POST /v1/vaults/{vaultId}/oauth/start` (application keys acting for no one, installation vaults only) takes `{ url, server, clientId? }` and answers `{ authorizeUrl, expiresAt }`. The Runtime discovers the server's authorization server (RFC 9728, then RFC 8414), registers itself (RFC 7591) unless `clientId` names a registered client, and starts an S256 PKCE sign-in whose `state` works once, for ten minutes. A server without registration and no `clientId` is `400 oauth_client_required`.
  - `GET /v1/oauth/callback` takes the browser back: anonymous and unversioned like an artifact link, it exchanges the code and stores an `oauth` credential bound to the URL, named after `server` (connecting again rotates it), and answers a small HTML page. An unknown, used or expired `state` is `oauth_state_invalid`; the authorization server's refusal is `oauth_failed`. The callback's base is `NYLORUN_PUBLIC_URL` (`TenantConfig.publicUrl`), else the start request's origin.
  - Every OAuth step runs in the gateway's keys module (F9-D14): the runtime container never sees a token, the PKCE verifier or a client secret, and makes no outbound call. Migration 0009 adds `oauth_pending`, with the verifier and secret sealed under the vault key. `Keys` gains `startOAuth` and `finishOAuth`.
  - OAuth requests, including refresh of every OAuth vault credential, now go through `guardedFetch` (`tenant/outbound.ts`): the `NYLORUN_ENDPOINT_*` address policy checked on the address connected to, no redirects, a bounded answer. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a token endpoint on a private address is refused, where refresh used to call it.
  - `@nylorun/core`: `ERROR_CODES` adds `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`; `StartOAuthRequestSchema` and `StartOAuthResponseSchema`.
  - `nylorun mcp connect <url> --server <name> [--vault <id>] [--client-id <id>]`: creates the installation vault `mcp` if needed, opens the sign-in page and waits up to 10 minutes for the credential. See DEPLOYMENT.md, "Connecting a remote MCP server with OAuth".

- 5cfaed9: **Operator keys, and project links on them (F9 I1).** The Admin API manages the Tenant's application keys by name: `PUT /v1/admin/keys/{id}` creates a key or rotates it and returns it once, `GET /v1/admin/keys` lists every key's id, role and issue time (never the keys), and `DELETE /v1/admin/keys/{id}` removes one. A rotated or deleted key stops authenticating on its next request. Ids follow `^[a-z][a-z0-9-]{0,31}$`; `studio` (derived from the admin key) is refused. Keys keep today's format (64 hex) and only their SHA-256 is stored, in the existing principals table (no migration). Host feature `operator-keys` (additive, protocol unchanged); core adds the `OperatorKey`, `ListOperatorKeysResponse`, `PutOperatorKeyResponse` and `DeleteOperatorKeyResponse` schemas.

  - `@nylorun/admin`: `admin.keys.put(id)`, `admin.keys.list()` and `admin.keys.delete(id)`; they refuse with `incompatible_host` when the Host lacks `operator-keys`.
  - `nylorun key put|list|rm <id>` manages a running local Tenant's keys; `put` prints the key once on stdout.
  - `nylorun start` no longer derives the project's key. It keeps `.nylorun/credentials.json` while its key still reaches the Tenant (one authenticated read); otherwise it gives the project the operator key `project`, which the Host root keeps in `project-credentials.json` (0600) so every checkout linked to the Tenant shares it. An existing derived project key keeps working and is adopted.
  - `nylorun sandbox` uses the linked project's key, or the operator key `cli` it puts once and keeps in `<Host root>/cli-credentials.json` (0600).
  - The ephemeral Runtime (`startEphemeralRuntime`) no longer registers the derived `project` principal; pass `derivedPrincipals: ["project"]` to keep it. Derived principals (`NYLORUN_DERIVED_PRINCIPALS`, `deriveTenantKey`) still work on a Host.

- c0b604e: **Trusted issuers (F9 I2).** The Tenant API accepts JWTs from the operator's own identity provider as bearers, configured in an identity file: `NYLORUN_IDENTITY_FILE` names a YAML file listing each issuer's `name`, `issuer`, `audience`, `jwks` URL or static PEM `keys`, a `subject` template over scalar claims (`u:{sub}`), `scopes` from a claim or a fixed list, `allowedScopes`, an optional `agents` allowlist, optional `sandboxes` grant templates (`{org_id}/*`) and `maxLifetime`. A malformed file stops the boot, naming the issuer and the field; a subject template without a claim is malformed. A bearer whose unverified `iss` names an issuer is verified with RS256, ES256 or EdDSA only, up to 16 KiB, `aud` matching, `exp` and `iat` required and `exp − iat` within `maxLifetime`, and becomes a token caller (`role: issuer:<name>`) with the issuer's scopes, agents and rendered sandbox grants; subject revocation does not reach it. JWKS keys are fetched only from the configured URL (no redirects), cached by `kid`, refetched at most once a minute for an unknown `kid`; while a JWKS is unreachable cached keys keep working and a new `kid` is `401 issuer_unavailable` (new error code). A browser request with an issuer token needs no publishable key (CORS comes from the operator's proxy). New: `GET /v1/me` reports the subject, scopes, agents, sandbox grants and `via` (`application:<id>`, `subject`, `token` or `issuer:<name>`) of any credential; the issuer-only scope `studio`; `ISSUER_SCOPES`, `CALLER_SCOPES` and `MeResponseSchema` in `@nylorun/core/contracts`; `parseIdentityFile` and `createTrustedIssuers` in `@nylorun/runtime`, and an `issuers` option on `startEphemeralRuntime`; Host feature `trusted-issuers` (additive, protocol unchanged). `nylorun start` sets `NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml` on the runtime container when `<Host root>/identity.yaml` exists.

## 0.12.0-beta

### Major Changes

- b352feb: **File artifacts, message parts and capability links (protocol 6).** Upgrade these with the Runtime: they speak protocol 6, which this Runtime serves beside 4 and 5. See MIGRATION.md.

  - **`@nylorun/runtime`: file artifacts.** A file is an artifact: an `af_` id, a name and numbered immutable versions, with rows in the new `artifacts` and `artifact_versions` tables (migration `0004_artifacts`) and bytes in the Object store (`BlobStore`). `POST /v1/artifacts?name=&sessionId=` uploads a file in one streamed request and `POST /v1/artifacts/{id}/versions` adds a version, within the Tenant's limits (`GET`/`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default); a body past either is `413 limit_exceeded`, refused mid-stream with nothing stored. `GET /v1/artifacts` lists them (by session), `GET /v1/artifacts/{id}` reads one with its versions, `GET /v1/artifacts/{id}/versions/{n|latest}/content` downloads through the Runtime with HTTP Range (`206`, `Content-Range`, `416`), and `DELETE /v1/artifacts/{id}` deletes it with its bytes. A session's artifacts go with it on a sessions reset, and appear in its history as `artifact.created`, `artifact.version.created` and `artifact.deleted` (new in the event catalog). A subject reaches only the artifacts of their own sessions.
  - **`@nylorun/runtime`: capability links.** `POST /v1/artifacts/{id}/links` mints a short-lived path, `/v1/artifact-links/<token>`, that downloads one version (with Range) with no credential and no `Nylorun-Protocol`: an ES256 JWT (`typ: nylorun-artifact+jwt`) signed with the Tenant's signing key, at most 15 minutes, and dead once the artifact is deleted. The Host logs its path without the token.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): message `parts`.** A user message may carry `parts`: `text`, and `file` by `artifactId` (and `version`, else the latest, pinned when the message is accepted). Model-gate reads the file from the Object store: an image goes to the model as image input, a text file as text, and any other file fails the call (`invalid_request`). The record and the transcript hold only the reference. The gateway builds its `BlobStore` from `NYLORUN_OBJECT_STORE_*` (the Tenant's `fs` store without it). `PROTOCOL_VERSION` is 6; `HOST_PROTOCOL` is 4–6 and protocol 6 clients require the feature `artifacts`.
  - **`@nylorun/runtime`: `save_artifact`.** A session with a sandbox gets the `nylorun.artifacts` capability, whose `save_artifact` tool saves a sandbox file (`path`) or text (`content`) as an artifact of the session, carrying the turn and tool call on its event.
  - **Breaking (`@nylorun/runtime`): `MediaStore` is removed.** `MediaStore` and `localMedia` leave `@nylorun/runtime/node`, and `piModel` takes `files` (a resolver from an artifact reference to its bytes) instead of `media`; images are file artifacts. The image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`) stay.
  - **`@nylorun/agents`:** `client.artifacts` (`upload`, `uploadVersion`, `list`, `get`, `download` with a range, `link`, `delete`), also on `BrowserClient`, and `session.inputParts(parts)`. A request with a body of its own type keeps it.
  - `@nylorun/admin`, `@nylorun/cli`, `nylorun`, `@nylorun/studio`: speak protocol 6.

### Minor Changes

- 6077272: **Folder artifacts and the turn-end outputs export (F8.2).** Part of protocol 6, with file artifacts.

  - **`@nylorun/runtime`: the turn-end export.** When an agent's turn completes, the Runtime reads `/workspace/outputs` of the session's sandbox and keeps it as a version of the session's folder artifact `outputs`: the first export creates it, and each later turn whose outputs changed adds a version (`artifact.created` / `artifact.version.created` with `kind: "folder"`, `source: "export"`, `fileCount` and `claimed: true`, since the listing and bytes are what the sandbox supplied). Nothing is exported without a sandbox or without outputs. An export past 10,000 files, 1 GiB, the per-file limit or the Tenant total stores nothing and records `artifact.export.skipped` with its reason; a failure records `artifact.export.failed`. Neither fails the turn. Core reads the workspace through one seam, `WorkspaceReader`, which the Harness API and pod sandboxes will implement later.
  - **`@nylorun/runtime`: folder artifacts.** A folder version is a manifest of paths to content-addressed files: each file's bytes are stored once at `blobs/sha256/<hex>`, so an unchanged file is never stored again, and the Tenant total (`GET /v1/tenant/artifacts` `usedBytes`) counts it once. New routes: `GET /v1/artifacts/{id}/versions/{n|latest}/tree` (the manifest), `…/files/{path}` (one file by its percent-encoded path, with Range), `…/diff?from=n` (files added, removed and changed) and `…/zip` (a streamed zip). `POST /v1/artifacts/{id}/links` takes `file` to link one file of a folder; a folder's link without it opens the zip. A folder's `/content`, a new version uploaded to a folder, and a message part naming a folder are `400`. Deleting a folder removes the files no other version names. Migration `0006_folder_artifacts` allows the `folder` kind and adds the `artifact_content` table.
  - **`@nylorun/core`:** `ArtifactKindSchema` (`file`, `folder`), the `export` source, `FolderEntrySchema`, `FolderManifestSchema`, `ArtifactTreeSchema`, `ArtifactDiffSchema`, the `artifact.export.skipped` and `artifact.export.failed` events, and `fileCount` and `claimed` on `artifact.created` / `artifact.version.created`.
  - **`@nylorun/agents`:** `client.artifacts.tree()`, `file()`, `diff()` and `zip()`, and `link(id, { file })`.

- b6bf1f5: **Harness API v1, in process (F6.1).** Every segment now runs in a harness: the advance takes the session's lease and offers the segment as a run, and the Tenant's own harness, in the same process, runs the engine and reports how it ended. Core settles it exactly as before. Nothing changes on the wire: protocol 5, durable checkpoint 1, engine `hosted-3` and the Action endpoint wire are the same.

  - `@nylorun/core/harness-api`: the protocol (messages, Zod schemas, the effect request hash, transcript edits, an RPC channel with an in-process memory transport).
  - `@nylorun/harness/api`: `createHarness({ channel, executors })`, a harness that leases runs, renews their leases, replays a run's recorded outcomes without asking, keeps transcripts by record cursor, and runs model, MCP and sandbox calls through the executors it is given.
  - `@nylorun/runtime`: the Harness API server per Tenant (`TenantHandle.attachHarness`), the in-process harness, and the journal as the Record seam. A model call's journal row now stores the request's hash without its prompt, so a replay never sends a prompt twice. `NYLORUN_HARNESS_API=0` runs the engine in the advance as before, until F6.2 removes it. A Runtime older than this one may fail a turn that was in flight across a downgrade with drift.

- 8ed4ea6: **Harness service over WebSocket, with the workspace capability (F6.2).** A Runtime started with `NYLORUN_HARNESS=remote` runs no harness of its own: it opens the Harness API listener (`NYLORUN_HARNESS_LISTEN_HOST`/`_PORT`, default port 4200, `NYLORUN_HARNESS_ALLOWED_HOSTS`), which accepts only the harness credential (`NYLORUN_HARNESS_TOKEN`) on `/nylorun/harness/v1`. The runtime image's `--service harness` connects to it (`NYLORUN_HARNESS_URL`, `NYLORUN_HARNESS_TOKEN`, `NYLORUN_GATES_URL`, `NYLORUN_HARNESS_ROOT`) and runs the Tenant's segments, MCP servers and sandboxes with no store; it refuses to start with a database, the gates' or keys' credential, or Restate settings, and presents only run tokens at the gates. The in-process harness stays the default.

  - `@nylorun/core/harness-api`: the `workspace.*` requests core sends to a harness that serves workspaces, `tenantId` in the `hello` answer, a workspace record on `sandbox.state` claims, and `TurnStart.options.holdMs`. Tenant and admin status report the Tenant's harnesses (`harness`).
  - `@nylorun/harness/api`: `createHarness` declares capabilities, reports grants (`onGrant`) and the `hello` answer, readies MCP through `executors.prepare` (`session.mcp`), and holds a run while its Action is pending until core sends the outcome (`effect.resolved`).
  - `@nylorun/runtime`: the WebSocket listener and client, `--service harness`, the workspace capability (`ctx.sandbox` is a `WorkspacePort`; sandbox tool routes, `save_artifact`, sweep and reset reach the harness's workspaces), the SandboxManager's records port, and held runs (`actionHoldMs`, default 5 minutes). `save_artifact` runs in core. `NYLORUN_HARNESS_API` and the engine run in the advance are removed; tests run with `NYLORUN_TEST_HARNESS=memory|json|ws`.

- 678e085: **Pod sandboxes (F7.2, second part).** With `nylorun sandbox enable`, a sandbox resource of kind `pod` (`PUT /v1/sandboxes/{id}` with `kind: "pod"`, an `image`, `*.suffix` hosts, `storage` and `lifecycle.ttl`) is an agent-sandbox pod on the Tenant's cluster, created at once. The turns of the sessions attached to it run in the pod: the engine is copied from the Runtime image into the pod (the Runtime image now carries tini for it), waits until the pod's NetworkPolicy is in force, exchanges its join token for a host token at the Harness API listener (`POST /nylorun/harness/v1/host/join`, published for pods on the Docker host's address, with the gates), and serves its sandbox alone. New: `POST /v1/sandboxes/{id}/stop` and `/reset`; the Tenant's `limits.ttl`, `lifecycle.onExpiry`, `lifecycle.stopGrace` and `placement`; idle stop; lifecycle events `sandbox.running`, `.suspended`, `.expired`, `.relaunched`, `.lost`, `.reset` and `.failed`; error codes `placement_refused`, `sandbox_lost` and `sandbox_expired`; `cluster` in `GET /v1/tenant/sandbox`; Host feature `sandbox-pods` (additive, protocol unchanged). Without a cluster, kind `pod` is `409 sandbox_unavailable` (it was 400). Migration `0007_sandbox_pods` adds the pod lifecycle columns to `sandbox_resources`.
- 926711b: **Sandboxes are a resource (F7.1, blueprint D39; Host feature `sandboxes`).** A sandbox has its own id, a kind, a spec and labels, and outlives the sessions attached to it. Additive: protocol 5 is unchanged.

  - `PUT /v1/sandboxes/{id}` creates a sandbox or finds the one with that id (get-or-create in one call); `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=key=value` (repeatable), `GET /v1/sandboxes/{id}/events` and `DELETE /v1/sandboxes/{id}`. Ids are `/`-separated segments (`team-a/proj-42`), sent percent-encoded as one path segment. Only kind `virtual` runs; `pod` is refused with `sandbox_unavailable`. The spec is resolved against the Tenant's limits and fixed once the sandbox exists; labels can change.
  - A session attaches with `sandbox: { id }` and shares the sandbox's `/workspace` with every other session attached to it. Turns are serial per sandbox: a second session's turn is refused with `409 sandbox_busy` while another runs. Deleting a session (a sessions reset) only detaches it. Deleting a sandbox is refused while a turn runs in it; afterwards an attached session's next turn is refused with `sandbox_unavailable` until a sandbox with that id exists again.
  - Subject tokens carry an `sbx` claim: `POST /v1/tokens` takes `sandboxes`, exact ids or prefixes ending in `/*` (at most 16). A token reaches only the sandboxes they match, checked when a session attaches and at every turn start (`403 sandbox_not_granted`); any other sandbox is the 404 of a missing one. The new scope `sandboxes:write` lets a role create and delete the sandboxes its grants reach. Application keys reach every sandbox.
  - The Tenant holds at most `limits.sandboxes` sandboxes (`PUT /v1/tenant/sandbox`, default 100); one more is `409 limit_exceeded`.
  - Lifecycle events (`sandbox.created`, `sandbox.attached`, `sandbox.detached`, `sandbox.deleted`) go to the sandbox's own stream in the record, through the record module; the session's log records `sandbox.attached`. The sandbox stream is not relayed to S2.
  - New error codes `sandbox_not_granted`, `sandbox_busy` and `sandbox_unavailable`; the session view gains `sandboxId` and `sandboxSource: "sandbox"`. Migration `0004_sandbox_resources` adds `sandbox_resources`, `nylorun_streams.sandbox_events` and the sessions' `sandbox_id` column.
  - `@nylorun/agents`: `client.sandboxes` with `ensure(id, spec)`, `get`, `list({ labels })`, `delete`, `events`, and `forSession({ session, spec })`, which creates a sandbox for one session, opens the session on it, and deletes it with `release()`. It replaces sharing through another session (`sandbox: { session }` and the view's `sandboxOwnerId`, now deprecated). `client.tokens.create` takes `sandboxes`.
  - `nylorun sandbox ls [--label key=value]... [--json]` and `nylorun sandbox rm <id>` list and delete the running local Tenant's sandboxes.

## 0.11.0-beta

### Minor Changes

- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

## 0.10.0-beta

### Major Changes

- 5ca1923: **Clients for one Tenant per installation: a stack per project, nothing selects a Tenant.** Upgrade these with the Runtime; they speak protocol 5. Existing stacks are left as they are: see MIGRATION.md.

  - **Breaking (`nylorun`): one stack per project.** `nylorun start` in a project creates the project's stack (named after the project directory, or `--name`; Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, its own free ports and volumes), waits for its Runtime to create the stack's Tenant, writes the Project link (`.nylorun/link.json` format 2: `stack`, `hostUrl`, `hostId`, `tenantId`) and `.nylorun/credentials.json` (the key of the derived principal `project`, derived from the stack's admin key), and seeds the model provider from the project's `.env`. `nylorun ls` lists the machine's stacks and `nylorun delete <name>` removes one with its volumes and Host root. `nylorun status` shows the stack's Tenant; `nylorun studio` opens it. The old single stack under `~/.nylorun` is never touched: `start` notes it, and `nylorun legacy stop|delete` handles it. Every stack command takes `--name <stack>` (or `NYLORUN_STACK`, or the Project link's stack); `start --no-link` starts a stack without linking the directory; `nylorun reset` resets the selected stack only. The runtime container's healthcheck is now `/health`, so a Tenant that cannot open is reported by `start` from the Admin status at once instead of after a 300 s wait. `NYLORUN_HOME` still overrides the Host root. Stacks start and stop only when you say so.
  - **Breaking (`@nylorun/cli`): no Tenant commands.** `nylo tenant create|use|list|current|delete` are removed; `nylo status`, `nylo reset` and `nylo endpoints` replace `nylo tenant status|reset|endpoints` on the linked installation. `nylo env` prints `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` only. `nylo` no longer writes Project links.
  - **Breaking (`@nylorun/agents`): no Tenant to name.** The `tenant` option (`createClient`, `Transport`, `resolveConnection`, `createActionHandler({ runtime })`, `JwksCache`) and `NYLORUN_TENANT` are gone, and no request sends `Nylorun-Tenant`; a connection is a URL and a key. A Project link of format 0 or 1 is refused with `connection_missing`, naming `npx nylorun start`. `verifyDeliveryToken`'s `tenantId` is optional: without it any Tenant issuer is accepted, since the installation's keys bind it. `TENANT_HEADER` is no longer re-exported.
  - **Breaking (`@nylorun/admin`): status only.** `createTenant`, `listTenants`, `getTenant` and `deleteTenant` are removed; `status().tenant` names the Host's Tenant, and `deriveTenantKey` / `deriveStudioToken` derive its keys. Local Host resolution reads the stack's Host root (`stack` option, `NYLORUN_STACK`, or the Project link's `stack`); `NYLORUN_HOME` and `home` still override it. `stackHostRoot(name)` is exported.
  - **Breaking (`@nylorun/studio`): Studio serves its installation's Tenant.** The Tenant picker, list and create are gone, with `/_studio/tenants`; `/` opens `/tenants/<id>`. The `/tenants/:tenant` routes and the login token's `tenant` claim stay for embedders and must name that Tenant. The proxy sends no `Nylorun-Tenant`.
  - **`@nylorun/create-agent`:** the next steps are `npx nylorun start`, then `npm run dev`.
  - `@nylorun/core`: `ProjectLinkFileSchema` accepts format 2 with `stack`, and `tenantId` is optional; `ERROR_CODES` loses `tenant_conflict` and `active_work`.

- 5ca1923: **One Tenant per installation: a database per Tenant, protocol 5.** A Runtime serves exactly one Tenant, the one its Postgres database holds. Two Tenants are two installations.

  - **Breaking: fresh start.** The Tenant's state is in the fixed schema `nylorun` of its own database and its record in `nylorun_streams`, keyed by session (no `tenant_id`). A database written by an earlier Runtime (`tenant_<id>` schemas, or a record keyed by Tenant) is refused: the Host stays up but not ready, and `/v1/admin/status` names the cause `database-layout-old`. Point the Runtime at a new database (with the local stack, a new stack); the old one is never changed.
  - **The Host creates its Tenant** on first start, in the migration transaction: `NYLORUN_TENANT_ID` (default a new id), `NYLORUN_TENANT_NAME` (default `default`), the Studio principal and the derived principals of `NYLORUN_DERIVED_PRINCIPALS` (comma-separated, default `project`), whose keys the admin key derives (`deriveTenantKey`). Later starts open the same Tenant and add derived principals configured since.
  - **Breaking: no Tenant catalog.** `/v1/admin/tenants` and `/v1/admin/tenants/{tenantId}` are gone (404). `AdminStatus.tenants[]` is replaced by `AdminStatus.tenant` (`id`, `name`, `state: open | unavailable`, `envelope`, and `cause` when it could not be opened). `CreateTenantRequestSchema`, `AdminTenantSchema`, `AdminTenantStatusSchema`, `AdminTenantListSchema` and `QuarantineSchema` leave `@nylorun/core`; `HostTenantSchema` and `TenantCauseSchema` replace them. `@nylorun/admin`'s `listTenants`, `getTenant`, `deleteTenant` and `createTenant` are removed (see below).
  - **Readiness instead of quarantine.** A Tenant that cannot be opened (`schema-too-new`, `kek-missing`, `migration-failed`, `envelope-invalid`, `database-layout-old`, …) fails `/ready` (check `tenant`, which replaces `discovery`) and is reported with its repair in `/v1/admin/status` and the log; every Tenant request gets the opaque 404. A failure outside it (Postgres unreachable) is retried.
  - **Protocol 5.** `PROTOCOL_VERSION = 5`; the Host serves protocols 4 and 5 for one release. Clients no longer require `runtime-tenants`; the Host still advertises it. No request needs `Nylorun-Tenant`: a request without it reaches the Host's Tenant, and one naming another Tenant (or a malformed one), or a publishable key of another Tenant, gets the opaque 404. The OpenAPI documents drop the header parameter and the Admin Tenant routes.
  - **Paths.** The Tenant directory is `<Host root>/tenant/` (was `tenants/<id>/`); `trash/` and the SQLite move to it are gone. The gates service serves its database's Tenant, and its `Nylorun-Tenant` header is optional (when sent, it must name that Tenant).
  - **Breaking: `startEphemeralRuntime` needs a database; the in-memory Session Store is removed.** `StartEphemeralRuntimeOptions.database` is required: a Postgres URL, for which the Runtime opens a pool and ends it on `close()`, or a pool the caller ends. It creates its Tenant in that database through the same bootstrap as a Host, or serves the Tenant the database already holds; the data stays after `close()`, so give each test Tenant a database of its own. Durable Streams and scheduling stay in process. See `MIGRATION.md`.

### Minor Changes

- fed780d: **Hard caps on model spend.** A Tenant can cap what its model calls use, per turn, per agent per UTC day or month, or for the whole Tenant per day or month, in USD, tokens or both. Before each call the model gate checks the scope's recorded spend, plus its calls in flight, against the cap. Once a cap is reached the call fails with the new `budget_exhausted` code, which is never retried, and the turn fails with `model.budget_exhausted`. A runaway loop stops there, at most one call over its cap.

  - `PUT /v1/tenant/budgets` replaces the budgets and `GET /v1/tenant/budgets` reads them. Both need the application key or `tenant:settings`.
  - `@nylorun/core` adds `budget_exhausted` to `ModelFailureCode` and `MODEL_FAILURE_CODES`, plus `ModelBudgetSchema`, `PutModelBudgetsRequestSchema` and `ModelBudgetsSchema`. Code that switches over failure codes exhaustively needs the new case.
  - Custom endpoints are priced at $0, so only a token limit stops them.
  - Budgets survive a `sessions` reset. A reset of scope `all` clears them.

- fed780d: **Every model call is recorded in the Tenant's usage ledger.** The model gate writes one row per call that answers: the session, turn and agent, the provider and model, the tokens (input, output, cached, cache write, reasoning) and pi-ai's price in USD. Custom endpoints count as $0. A call the gateway ran twice after a restart is recorded twice and flagged as a duplicate, since the provider billed both.

  - `GET /v1/tenant/usage?scope=tenant|agent|turn&id=&period=day|month|total` totals the ledger. It needs the application key or `tenant:settings`, like the other Tenant settings.
  - `@nylorun/core/contracts` adds `ModelUsageScopeSchema`, `ModelUsageQuerySchema` and `ModelUsageTotalsSchema`.
  - The ledger survives a `sessions` reset. A reset of scope `all` clears it.
  - The gateway and the runtime must run the same build, as before.

- 7f4c3f1: **One history: a session's transcript is folded from its record.** The own loop's model-facing transcript is no longer stored on the session row, where up to three copies of it lived (`state`, `turnStartState` and the checkpoint). After each segment that keeps its state, the Runtime records the change as an internal `transcript.updated` event: the new entries, or a snapshot after compaction. Each segment folds the transcript back from the record, and a cancelled or failed turn's entries are undone, as before.

  - **Internal events.** `transcript.updated` is in the event catalog with `visibility: "internal"`. SSE, history, AG-UI and A2A never serve it. Served events can therefore skip the seq numbers internal events hold; cursors resume as before. `TranscriptUpdatedPayloadSchema` is exported from `@nylorun/core/contracts`, and catalog entries may declare `visibility`.
  - **No checkpoints table.** Every settle used to write a copy of the session's checkpoint to a `checkpoints` table that nothing read; it is gone. The checkpoint a session resumes from stays on the session row.
  - **Storage.** A long session's row no longer grows with its transcript (a 10-turn, 300-step session on a 16k window: under 16 KB instead of up to 196 KB).

## 0.9.0-beta

### Major Changes

- c121144: **Definitions no longer declare a sandbox.** `.sandbox()` on ReAct and flow agents, and the `sandbox`, `SandboxError`, `SandboxOptions` and `SandboxCapability` exports, are removed. Open the session with one instead, `createSession({ sandbox: { … } })`, or set the Tenant's default; see `MIGRATION.md`.

  - **Build and registration.** A capability that still carries `sandbox` fails the build (`sandbox.in-definition`), and `PUT /v1/agents/:id` refuses such a definition with a `400` that names it. Definitions stored before this release keep their sandbox.
  - **Trees.** `sandbox.mismatch` and `workflow.sandbox-mismatch` are gone, with the workflow manifest's derived `sandbox`: a tree shares the sandbox its session was opened with.
  - **Executors.** The action claim reports whether the session has a sandbox (`ActionClaim.sandbox`), and `ctx.sandbox` follows it.

- 9546ac7: **Postgres is the record of every session event; S2 delivers it.** Durable Streams v1.

  - **The record.** Each event is written to `nylorun_streams.session_events` in the transaction that causes it, with the session's log head. The per-Tenant outbox, its relay, its drain in the Tenant sweep and `StreamGapError` are gone: losing S2's data, the relay or its replication slot now costs delay, never events.
  - **The stream relay.** With S2, every `api` or `all` Runtime process runs the relay; its Postgres replication slot (`nylorun_stream_relay`) lets exactly one be active. It appends with `matchSeq`, acknowledges the slot only after S2 has the events, refills gaps from the record, and reconciles the record with S2 after a new or lost slot. Without S2 (a local development Host), each Tenant relays its own commits.
  - **Postgres needs logical replication.** The Runtime refuses to start an `api` or `all` process with S2 unless `wal_level = logical` and its role may replicate; the error names the setting. The local stack is configured for it. See `DEPLOYMENT.md`.
  - **No incarnations.** A session's stream is `sessions/<id>`. A sessions reset moves the Tenant to a new **basin generation**: the old basin gets a `sessions.reset` signal, every process moves its readers, and the old basin is deleted after a grace period. Tenant deletion deletes every generation's basin and the Tenant's record rows.
  - **Status.** Tenant status `streams` reports `generation` and the Tenant's `relay` instead of the outbox; the Host aggregate reports the process's `relay` (with its slot lag in bytes) instead of `outboxDepth` and `relayLagMs`.
  - **Session history does not survive the upgrade.** Installs are in beta, so Tenant schema migration 8 is a fresh start for session data: a Tenant with sessions loses them, with their commands, checkpoints, effects, Actions and links, as a sessions reset does, and moves to basin generation 1; its settings, agents, Action endpoints, keys, policy and vaults stay. Clients holding cursors start again.

- 9546ac7: **Protocol 4: every session event is typed, on the `nylorun.event/2` envelope.**

  - **The catalog.** `EVENT_CATALOG` in `@nylorun/core/contracts` lists every event type the Runtime writes, with its payload schema, its schema version and its source. `SessionEventSchema` is their union, discriminated on `type`; `parseSessionEvent` types a known event and returns an unknown one as the bare envelope.
  - **The envelope.** Events carry `schema`, `seq`, `epoch`, `runId`, `incarnation`, `schemaVersion`, `source`, `evidence`, `visibility`, `retention` and an optional `trace`. `createdAt` is renamed `time`. The envelope is no longer strict, so later fields never break a client.
  - **Validated writes.** `Tx.event` is typed by the catalog, and both Session Stores check each event against it before it commits (`InvalidEventError`). Workflow `action.pending` payloads may carry `path` and `key`.
  - **OpenAPI.** Each event type is a component (`MessageAssistantEvent`, …), `SessionEvent` is their union, and the session SSE and history responses refer to them.
  - **Clients.** `@nylorun/agents` reads events with `parseSessionEvent`, so a newer Runtime's event types reach your code instead of failing the stream. Studio reads `time`.

  See `MIGRATION.md`.

### Minor Changes

- c7614a4: **A2A: serve agents to other agents (v1, gateway mode).** The Runtime answers [A2A](https://a2a-protocol.org) 1.0 over JSON-RPC for the Tenant's agents (optional Host feature `a2a-endpoint`), and the app server publishes them with `createA2aHandler`.

  - **Runtime.** `POST /v1/a2a/agents/:agent` acts for a subject with `sessions:own`. It serves `SendMessage` (blocking up to 5 minutes, or `returnImmediately`), `GetTask` and `CancelTask`. A context is one session per subject, agent and `contextId`, and a task is one turn. A question pauses the task as `TASK_STATE_INPUT_REQUIRED` until the caller replies on the same task. The `messageId` is the idempotency key. `ListTasks`, streaming, push notifications and the extended card answer with their A2A errors, and approvals cannot be answered over A2A yet. `GET /v1/a2a/agents/:agent/card` returns the card built from the manifest, without interfaces. `observeSession` lets in-process readers join a session's shared event feed.
  - **Agents SDK.** `@nylorun/agents/a2a`: `createA2aHandler({ agents, subject, publicUrl, card })` forwards each partner's JSON-RPC request to the Runtime as that partner's subject, and serves the Agent Card with its own URL, provider and security schemes. It loads no A2A package. `Transport.forward` returns the Runtime's raw response.

- 679c488: **Action endpoints: the Runtime delivers Actions (Host feature `action-endpoints`).** For an agent with a registered endpoint, each tool call, hook and workflow `fn`, `verify` or tool node is POSTed to the endpoint and the answer settles it. Agents without one keep their executors.

  - **The request.** `{ type: "action", action, sandbox }`, with a delivery token in `Nylorun-Signature` (for this Tenant, URL, Action, generation and body) and the Action id as `Idempotency-Key`. Deliveries of one Action never overlap, and at most `maxConcurrent` are in flight per endpoint.
  - **The answer.**
    - `200` with `Nylorun-Outcome: 1` is the outcome. A plain `200` is a tool's output, or what an `fn` or `verify` returned; the tool's output schema still applies.
    - `202` means the result comes later.
    - `429` and `503` (honouring `Retry-After`), a version mismatch (`409`) and anything that never reached the endpoint are retried, backing off from 250 ms to 30 s. The failure is reported as `action.delivery_failed` at most every 10 s.
    - Any other `4xx`, or a `3xx` (redirects are not followed), fails the Action with `endpoint.rejected`.
    - No answer after sending (timeout, reset, `5xx`) loses it: a tool becomes `uncertain`; a hook, `fn` or `verify` is delivered again. A delivery whose deadline passes (a Worker died) is lost the same way, by the Tenant sweep.
  - **Cancel.** A cancelled turn aborts the request at once. The code may have run, so the Action becomes `uncertain`, as a claimed one does.
  - **Events and health.** `action.delivered` and `action.delivery_failed` are new events. Endpoint health records successes and failures.
  - **Ping.** `POST /v1/endpoints/:agentId/ping` sends a signed ping and records what the endpoint serves. It answers `502` when the endpoint doesn't answer.
  - **Host settings.**
    - `NYLORUN_ENDPOINT_LOOPBACK=docker-host`: in the local stack, `localhost` means the Docker host.
    - `NYLORUN_ENDPOINT_PRIVATE` (`allow`/`refuse`): checked on the address actually connected to.
    - `NYLORUN_ENDPOINT_HTTP` (`allow`/`refuse`).
  - **Executors unchanged.** Executor results and deliveries record outcomes through one function, so the two paths behave the same.

- c85cd9e: **Action endpoints: register them (nothing is delivered yet).** An application registers, for each agent, the URL that will run its Actions. The Runtime stores the registration and its health; deliveries follow in a later release.

  - **Routes (application key only).**
    - `PUT /v1/endpoints` registers or updates up to 64 endpoints: `agentId`, `url` (http or https, no credentials or fragment), `implementationVersion`, optional `manifestHash`, `timeoutMs` (default 60 000, at most 840 000) and `maxConcurrent` (default 16).
    - `GET /v1/endpoints` lists them with their health: last delivery, last success, last error, consecutive failures, and what the last ping reported.
    - `DELETE /v1/endpoints/:agentId` removes one.
    - Subjects, subject tokens and executors are refused.
  - **One path per agent.** Registering an endpoint removes the agent's executor and ends its streams. `PUT /v1/executors` for an agent with an endpoint is `409`, naming the endpoint to remove first.
  - **Health.** Registering the same URL again keeps an endpoint's health; a new URL starts with none.
  - **Store.** Postgres migration 5 adds the `endpoints` table and a `deadline_at` column on Actions.
  - **Core.** Adds `DeleteEndpointResponseSchema`. The endpoint response schemas are strict.

- 4282d5f: **Breaking: executors are removed; protocol 3.** The Runtime delivers every Action (tool, hook, `fn`, `verify`) to the Action endpoint an agent registers. It no longer offers Actions for executors to claim. See `MIGRATION.md`, "Action endpoints replace executors".

  - **Core.** `PROTOCOL_VERSION` is 3 and a Host serves only protocol 3. `action-endpoints` is a protocol feature instead of an optional Host feature. Removed:

    - the executor, claim and Action-list schemas;
    - `action_result` from `SessionCommandSchema`;
    - the `claimed` Action status, `claimId` and `leaseExpiresAt`.

    New: `ActionResultReceiptSchema`, the receipt of `POST /v1/actions/:id/result`, which is `AcceptedResponse` without `requestId`.

  - **Runtime.** Removed:

    - `PUT`/`GET /v1/executors`, `DELETE /v1/executors/:agentId`, `GET /v1/executors/connect`;
    - `GET /v1/actions`, `POST /v1/actions/:id/claim`, and the executor form of `POST /v1/actions/:id/heartbeat`;
    - the `tenant/work` stream;
    - claim expiry;
    - executor credentials.

    `POST /v1/actions/:id/sandbox/:tool` takes the delivery token only. Tenant summaries report `inFlightDeliveries` instead of `connectedExecutors`. Tenant status lists each agent's endpoint and has an `endpoints` check instead of `executors`.

    Postgres migration 6 drops the `executors` table. Actions an executor had claimed are handled like lost deliveries: a tool becomes `uncertain`, and a hook, `fn` or `verify` is delivered again.

  - **Agents.** Removed: `connectAgents`, the `@nylorun/agents/executor` subpath, derived executor keys and `NYLORUN_EXECUTOR_KEY`. Serve agents with `createActionHandler` and call `register({ url })`.
  - **CLI.** Executor keys are gone from Project credentials. `nylo tenant endpoints` shows each endpoint and its health.

- 82d95ef: **Action endpoints: background tools, CLI and Studio.**

  - **Background tools (core, agents).** `tool({ …, background: true })` marks a tool that runs longer than an endpoint's timeout. The option is code-only and never serialized into the manifest. `createActionHandler` answers its delivery at once with `202`, runs the tool, heartbeats on the deadline the Runtime returns (each time with the newest delivery token), and posts the outcome. A heartbeat answered `409` (cancelled, lost or sent again) aborts the tool's `ctx.signal`, and nothing is posted. The new `waitUntil` option hands the background work to platforms that end a request's work with its response.
  - **CLI.** `nylo tenant endpoints [--json]` lists each agent's Action endpoint and how it is doing, and `nylo tenant endpoints ping <agent>` pings one through the Runtime.
  - **Studio.** Shows `action.delivered` ("Action delivered") and `action.delivery_failed` ("Delivery failed", with the endpoint's error and when it retries).

- f48f12f: **Action endpoints: contracts (groundwork, not served yet).** `@nylorun/core` adds the wire shapes for Actions the Runtime will deliver over HTTP to a URL the application registers, in place of executors. No Runtime serves them yet, and the Host does not advertise a feature for them.

  - **Contracts.** `EndpointRegistrationSchema`, `PutEndpointsRequestSchema`, `EndpointSchema` with `EndpointHealthSchema`, `ListEndpointsResponseSchema`, `ActionDeliverySchema` (an Action or a ping), `EndpointPingResponseSchema`, `DeliveryHeartbeatResponseSchema`, and the `action.delivered` and `action.delivery_failed` payload schemas. `Action.status` gains `delivering`, and Actions gain an optional `deadlineAt`.
  - **Constants.** `DELIVERY_TOKEN_TYPE` (`nylorun-delivery+jwt`), `DELIVERY_TOKEN_MAX_TTL_SECONDS` (900, the subject-token maximum), `ENDPOINT_TIMEOUT_DEFAULT_MS` (60 000), `ENDPOINT_TIMEOUT_MAX_MS` (840 000), `ENDPOINT_MAX_CONCURRENT_DEFAULT` (16), and in `@nylorun/core/compatibility` the headers `SIGNATURE_HEADER` (`Nylorun-Signature`) and `OUTCOME_HEADER` (`Nylorun-Outcome`).

- 50d0fb5: **AG-UI in the Runtime.** The Runtime serves AG-UI itself at `/v1/ag-ui/agents/:agent` (optional Host feature `ag-ui-endpoint`), and pages reach it directly with a subject token. `@nylorun/agents` no longer contains or depends on any AG-UI package.

  - **Runtime.** `POST /v1/ag-ui/agents/:agent` runs (a `RunAgentInput` in, server-sent AG-UI events out); `GET …/threads/:thread/messages`, `GET …/threads/:thread/events` (reattach) and `POST …/threads/:thread/cancel`. For a person named by a subject token (limited to the role's agents) or by subject headers; an application key alone is `400`. A thread's session (`sessionIdFor`, unchanged, so existing threads keep their sessions) is created on its first run with `forwardedProps.nylorun.session` (`vaultIds`, `credentialSelections`, and `info` from app servers only) and never changed afterwards. Limits and a busy session are streamed as `RUN_ERROR`. A stream opened with a token ends at the token's expiry or revocation with `CUSTOM nylorun.stream_closed`. The translation moves here from `@nylorun/agents`, and `@ag-ui/core` becomes a Runtime dependency.
  - **Agents SDK.** `createAgUiHandler` keeps its options and routes and forwards each request to the Runtime acting for the signed-in person; it now needs a Runtime with `ag-ui-endpoint` (`502 runtime_feature_missing` otherwise). `session()` options apply when a thread's session is created; whatever the browser sends in `forwardedProps.nylorun` is replaced. `@ag-ui/core` is no longer a dependency. `@nylorun/agents/browser` adds `agUi(agentId)`, a `{ url, fetch }` for `HttpAgent` that adds the key and a current token and reattaches a run the Runtime ended at token expiry, so the agent sees one run, and `agUiHistory()`. The transport gains `forward()`, which returns the Runtime's response as it is.

- 50d0fb5: **Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

  - **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
  - **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
  - **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
  - **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
  - **CLI.** `nylo access keys list|create|set-origins|revoke`.

- 6ab4c59: **Long sessions on any model: compaction.** A session whose history outgrows the model's context window keeps going, on a 16k local model as on a 1M hosted one.

  - **Compaction.**
    - **When.** Before each model call the engine estimates the prompt: the last reported usage, plus about four characters per token for what came after. If the estimate would not leave room for the reply, the engine first compacts: it asks the model to summarize the older history, then keeps about the newest 20,000 tokens (at most 30% of the window) verbatim.
    - **What it keeps.** The cut never separates a tool call from its result. The current turn's request is always kept. A later compaction merges with the earlier summary.
    - **Overflow.** If a provider still reports a context overflow, the engine compacts once and asks again.
    - **Storage.** The summary is a `compaction` transcript entry that replaces the older entries in the session state; the event log keeps the full history. The summary call is a journaled model effect, so replays are deterministic.
    - **New event.** `context.compacted` (`trigger`, `tokensBefore`, `tokensAfter`).
  - **Custom endpoints.**
    - **Settings.** Model Settings take `settings: { contextWindow, maxTokens, reasoning, compat }` for a custom OpenAI-compatible provider (vLLM, SGLang, llama.cpp, Ollama, LM Studio). `compat` is passed to pi-ai: `thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs` and the rest.
    - **Defaults.** Without settings, a custom endpoint is assumed to have a 32k window and an 8k output limit. They used to be 128k and 16k.
    - **Where to set them.** `nylo configure` asks for the window and output limit. Studio's Model Settings shows all four fields.
  - **Storage.**
    - Model effects no longer journal the model request next to the call, so each call's prompt is stored once.
    - When a turn ends, its model effects are slimmed to their identity and status; the transcript holds the answers.
    - Session storage now grows with the window, not with the square of the session's length.
  - **Core.**
    - `TranscriptEntry` adds `compaction` (`TranscriptCompactionEntry`).
    - `ModelAdapterContext.compaction` marks a summary call.
    - `CustomModelSettings` / `CustomModelSettingsSchema` describe the custom endpoint settings.

- 6ab4c59: **Model calls don't strand sessions.** A model provider failure is now a known outcome, not a lost call. The Runtime retries what can be retried, and otherwise fails the turn with `model.<code>`, so the session accepts the next message instead of sitting `uncertain` until it is cancelled.

  - **Runtime.**

    - **Upgrade.** The model adapter moves to pi-ai 0.99.1 and always streams.
    - **Per-call settings.**
      - Every call carries the session id, so OpenAI and other providers reuse the prompt cache and route to the same backend.
      - Provider auth no longer reads the process environment.
      - Rate limits, overloads, timeouts and transient errors are retried: 3 attempts with backoff, honouring `Retry-After`.
      - A stream that produces nothing for 300 s is aborted and retried. `TenantConfig.modelCall` sets attempts, backoff, the idle timeout and the request timeout.
    - **Failures.** Anything else fails the turn with one of these codes:

      - `model.context_overflow`, `model.rate_limited`, `model.overloaded`, `model.timeout`, `model.transient`
      - `model.content_policy`, `model.auth` (whose message says where to fix the credential)
      - `model.invalid_request`, `model.invalid_output`

      Only a call whose outcome was lost, such as a Worker dying mid-call, is still `uncertain`.

    - **Structured output.** A structured final answer is repaired (control characters, a Markdown code fence) before it is parsed.
    - **Model history.** Replayed history keeps the model that produced each message, so a model switch no longer sends one model's signatures or tool-call ids to another. Reasoning from OpenAI-compatible servers (`reasoning_content`, `reasoning`) is sent back only within the turn that produced it.

  - **Events.**
    - `message.assistant` adds `model` (`provider`, `model`), `finishReason` and `usage`.
    - A new `model.failed` transcript event (`code`, `message`, `retryable`) is written instead of `message.assistant` when a call fails.
  - **Core and harness.**
    - New types and helpers: `ModelFailureOutcome`, `ModelFailureCode`, `MODEL_FAILURE_CODES`, `isModelFailureOutcome`, `ModelProducer`.
    - `PromptItem` assistant messages may carry `producer`.
    - `ModelUsage` adds `cacheWriteTokens`.
    - A model adapter may return a failure outcome.
    - The durable engine version is `hosted-3`: a turn that is running when the Runtime is upgraded fails once with `execution.incompatible`, and the next message works.
  - **CLI.**
    - `nylo configure` passes a stable installation id to OAuth logins that need one (OpenAI "Sign in with ChatGPT"), stored as `cli-installation-id` in the Host root.
    - A custom OpenAI-compatible provider now prompts for its API key instead of failing.

- 2ab8ed1: **Schemas for every Runtime answer.** `@nylorun/core/contracts` now has a Zod schema for each successful response of the Tenant and Admin APIs that lacked one, so clients can validate what they receive and the Runtime's OpenAPI document can be generated from them.

  - **Agents:** `ListAgentsResponseSchema` (`AgentDefinitionViewSchema`), `ListPublicAgentsResponseSchema` (`PublicAgentSchema`) and `PutAgentResponseSchema`.
  - **Sessions:** `ListSessionsResponseSchema` (`SessionSummarySchema`, `SESSION_STATUSES`) and `SessionViewSchema`.
  - **Executors and actions:** `ListActionsResponseSchema`, `ActionHeartbeatResponseSchema`, `DeleteExecutorResponseSchema` and `SandboxToolOutcomeSchema`.
  - **Tenant settings:** `ResetTenantResponseSchema`, `HostModelCatalogSchema`, `ListProvidersResponseSchema` (`HostModelProviderInfoSchema`), and `TenantSandboxViewSchema` with `EffectiveSandboxConfigSchema` (the configuration with defaults applied, sizes in MiB).
  - **Vaults:** `VaultInfoSchema`, `CredentialInfoSchema`, `ListVaultsResponseSchema`, `ListCredentialsResponseSchema` and `DeletedResponseSchema`. `VaultInfo`, `CredentialInfo` and `HostModelProviderInfo` are now inferred from their schemas; their fields are no longer `readonly`.
  - **Access:** `AccessPolicyResponseSchema` and `ListPublishableKeysResponseSchema`.
  - **Admin:** `AdminTenantListSchema` and `HostShutdownResponseSchema`.
  - **Streams:** `StreamClosedFrameSchema` (the `nylorun.closed` frame) and `AgUiRunErrorCodeSchema` (codes of an AG-UI `RUN_ERROR`, which add `session_busy` and `runtime_error`).

  `ERROR_CODES` gains `request_rejected`, `invalid_request`, `subject_required` and `internal_error`, codes the Runtime already sends. `RejectedResponseSchema` now accepts every rejection the Runtime makes. An exhaustive `switch` over `ErrorCode` needs the new cases.

- c121144: **Choose a session's sandbox when you open it.** `createSession({ sandbox })` (`PutSessionRequest.sandbox`) now takes `false`, `{ session }` to share, or an inline sandbox: `image`, `network.allow` and `resources`. Omit it for the Tenant's default. The agent definition needs no `.sandbox()`: the Runtime resolves the request against the Tenant's limits, pins it on the session and adds the six sandbox tools to that session only (capability `nylorun.sandbox`). The registered definition is unchanged.

  - **Tenant configuration.** `GET /v1/tenant/sandbox` adds `config`; `PUT /v1/tenant/sandbox` sets `default` (`none`, `virtual` or an inline sandbox) and `limits` (`network` ceiling, `resources` maximum, `defaultResources`, `idle`). Unset, a Tenant's default is `none` and its ceiling is the package registries and code hosts of today's `dev` preset. `SeedTenantConfigRequest.sandbox.config` seeds it.
  - **Checks at open.** A request outside the limits is a `400` that lists every problem. An inline sandbox from a caller acting for a subject is a `403`; such callers get the Tenant default or `false`. An `image` is refused: the virtual sandbox has no images. The sandbox is fixed for the session's life: a different one on a later `PUT` is a `409`.
  - **Trees inherit.** The agent sessions of a flow agent, the agents a session uses as tools, and sessions attached with `{ session }` use the sandbox the session was opened with, and get its tools.
  - **Compatible.** An agent that declares `.sandbox()` keeps working as before; opening its session with a `sandbox` value is a `400` that says to remove `.sandbox()` from the agent.

- 9d52189: **Studio embedding contract.** `@nylorun/core/contracts` defines the contract between Studio and an app that embeds it in an iframe, and `@nylorun/agents/studio-embed` re-exports it for Studio's web app and embedders such as Babai Desktop.

  - `StudioEmbedMessageSchema`: every `postMessage` between the two, on the envelope `{ type: "nylorun.studio", protocol, kind }`. Kinds: `ready`, `init`, `token.refresh`, `theme.changed`, `navigate`, `session`, `token.expiring`, `route.changed`, `open.external`, `open.babai`, `error`. `STUDIO_EMBED_PROTOCOLS` is `[1]`.
  - `StudioLoginTokenRequestSchema` and `StudioLoginTokenResponseSchema` for `POST /_studio/login-tokens` (now with optional `tenant` and `subject`), and `StudioSessionRequestSchema` and `StudioSessionResponseSchema` for `POST /_studio/sessions`.
  - `parseFrameAncestors` and `isFrameAncestor` validate `NYLORUN_STUDIO_FRAME_ANCESTORS`: exact origins only, no wildcards, keywords, scheme-only entries or paths.

- 50d0fb5: **Subject tokens: a person's own credential for the Runtime.** An app server mints a short-lived token for one signed-in person, and their app calls the Runtime directly (optional Host feature `subject-tokens`). Requests with application keys and subject headers are unchanged.

  - **Runtime.** `POST /v1/tokens` (application key only) mints an ES256 JWT for a subject and a role, valid 60–900 seconds. The Tenant API accepts it as a bearer and resolves its scopes and agents from the role on every request. Forged, foreign or malformed tokens get the opaque `404`; an expired token, a revoked subject, a revoked key or a removed role gets `401 token_expired` with `WWW-Authenticate`. Tokens carry only `agents:read`, `sessions:own` and `vaults:own`; they may not set session `info`, send `message.manifest` or store OAuth refresh credentials, and `GET /v1/agents` shows them `{ agentId, name, description }` of their role's agents only.
  - **Access policy.** `GET`/`PUT /v1/access/policy`: roles with token scopes, an agent allowlist and limits (`turnsPerHour`, `concurrentTurns`, answered with `429 limit_exceeded` and `Retry-After`). Without roles nothing is minted.
  - **Signing keys.** Per Tenant, the private key sealed with the vault KEK: `GET /v1/access/signing-keys`, `POST …/rotate` (refused while the previous key may still verify live tokens; `force` for incidents), `POST …/:kid/revoke`, `GET /v1/access/jwks`. A Tenant with signing keys and no KEK is quarantined `kek-missing`.
  - **Revocation.** `POST /v1/access/revocations` ends a subject's tokens; their open event streams end with `event: nylorun.closed` on every process. A stream opened with a token also ends when the token expires.
  - Postgres migration 3 adds `signing_keys`, `subject_epochs`, `subject_usage` and an index on the session owner and status. New error codes `token_expired` and `limit_exceeded`.
  - **Agents SDK.** `client.tokens.create()`, `client.access.getPolicy()`/`putPolicy()`/`revokeSubject()`/`jwks()` and `client.access.signingKeys.list()`/`rotate()`/`revoke()`, each checking the Host feature first.
  - **CLI.** `nylo access policy get|set|init`, `nylo access signing-keys list|rotate|revoke`, `nylo access revoke <subject>` and `nylo access token` for trying the API.

### Patch Changes

- 18468d9: **Tenant routes start moving to Hono.** The executor and Action routes and session commands (`/v1/executors/connect`, `/v1/actions/**`, `/v1/executors`, `/v1/executors/:agentId` and `POST /v1/sessions/:id/commands`) are declared as Hono routes (`api/http/routes/executors.ts`). Each says who may call it: its credentials, subject scopes and browser access. The Runtime's OpenAPI document shows this, and the executor routes are marked deprecated there, since Action endpoints replace them. Answers are unchanged. A path the new routes don't match exactly still goes to the router they replace, so its answer is unchanged too.

  **Core:** the recursive contract schemas (JSON values, workflow nodes and manifests, and an agent used as a tool) carry a Zod `id`, so documents generated from them refer back to the named schema instead of recursing. Parsing is unchanged.

## 0.8.0-beta

### Minor Changes

- e537a82: **One `Agent` builder: named methods and flow agents.** Every capability has its own method, and deterministic workflows are written on the same builder. ReAct agent manifests are unchanged: the new syntax compiles to exactly what the old syntax produced.

  - ReAct agents: `.instructions()`, `.tools()`, `.subagents()`, `.mcp()` (a server's `name` defaults to its key; calls merge), `.skills()`, `.plugin()`, `.capability()`, `.sandbox()`, `.beforeTurn()`, `.beforeModel()`, `.afterModel()`, `.afterTurn()`, `.output()`. `capability({ id })` returns a builder with the same methods.
  - Flow agents: `.step()`, `.switch({ ...cases, default }, { on })`, `.parallel()`, `.map()` (runs over its input), `.loop(body, { verify, max | decide })`, plus `.input()`, `.output()`, `.sandbox()`, `flow()` for nested sequences and `.withId()`. Functions receive `{ input, results, flowInput }`, typed from each step's output schema. A flow agent compiles to a workflow manifest (v2, see the flow-manifest-v2 changeset).
  - Build diagnostics: `agent.mixed-body`, `flow.no-model`, `agent.single-value`, `flow.empty`, `loop.max-required`, `loop.invalid-max`, `mcp.duplicate-server`, `delegation.flow-unsupported`.
  - `sandbox()` and `mcp()` move to `@nylorun/core/define` (still exported from `@nylorun/agents`).
  - Deprecated, warning once each: options-form `instructions`/`tools`/`outputSchema` (`NYLORUN_DEP_AGENT_OPTIONS`), `.use(capability)` (`NYLORUN_DEP_USE`), `.before()`/`.after()` (`NYLORUN_DEP_HOOKS`), and `capability({ tools, instructions, … })` (`NYLORUN_DEP_CAPABILITY_OPTIONS`). See MIGRATION.md.

- 5278b4e: **Flow agents on workflow manifest v2.** A flow agent compiles to `workflowSchemaVersion: 2` and runs on the new `flow-2` engine; v1 workflows (`Chain`, `Switch`, `Parallel`, `Map`, `Loop`) keep running on `flow-1`, so in-flight runs finish as they began.

  - **Manifest (core).** Any node may carry `id` and `input`; there are no slots. `chain` and `parallel` are bare collections, a Map is `{ map: { each } }` over its input, and a Loop has `max?` and `decide?`. The header adds `name`, `description`, `metadata`, `inputSchema` and `outputSchema`, and `agents` embeds every agent the flow runs, so one manifest hash covers the whole flow. `Agent.from(json, { nodes, agents })` rebuilds a flow agent. Path and key helpers (`leafPath`, `stageKey`, `forEachFlowNode`, `embeddedAgent`, …) are exported from `@nylorun/core/define`.
  - **Paths (harness).** Linked agent sessions are named by the agent: its id, `[i]` per Map item, and a nested flow agent's id in front. Control stages add nothing, so wrapping a step in a Loop keeps its session. Functions are bound under stage keys (`route:on`, `@1.default.1:input`) and all receive `{ input, results, flowInput }`; `flowInput` works inside nested `flow()`. A Loop without `decide` retries with the verifier's feedback up to `max` and then fails with `loop.exhausted`. Nested flow agents run inline.
  - **Runtime.** Leaves of a v2 workflow resolve from its embedded `agents` (with the workflow's plugin roots, keyed `<agent>/<capability>`) instead of the registry. `loop.iteration` is emitted only for a Loop's own agent turns.
  - **Agents SDK.** `saveAgent(flowAgent)` PUTs one document; application mode registers the flow's executor with its manifest hash. An executor leaves `fn`, `verify` and tool actions of a v2 flow unclaimed when they belong to another manifest hash, because stage keys can shift between deploys; it reports each skipped action once through `onError`.
  - **Studio.** Draws v2 manifests: agents and tools at their session paths, control stages at their stage keys, nested flow agents inline, and lights a Map's agent from its item sessions.
  - Build diagnostics: `flow.duplicate-leaf`, `flow.duplicate-id`, `flow.agent-conflict`, `flow.v1-workflow`, `loop.invalid-verify`, `workflow.flow-agent-child`. Also fixes v1 flows passing an agent step's output to the next step still wrapped in the runtime's turn marker.

- 426fd27: **Flow agents as subagents.** `.subagents(flowAgent)` lets a ReAct agent delegate to a flow agent. The flow's workflow manifest v2 is inlined in the delegating tool (`ToolManifest.agent` may be a workflow manifest), so it is saved with the parent and served by the parent's executor, plugin roots included (`<flow>/<agent>/<capability>`).

  - **Engine (harness).** A call to a flow subagent is one durable `agent` effect (`role: "delegate"`) between the delegation's start and settle points; the flow's output is the tool result, and a failed flow is a failed tool result. Local `run()` refuses flow subagents, which need the Runtime.
  - **Runtime.** The effect starts a linked flow session from the parent's pinned manifest, fresh per call, and settles when the flow's turn ends. Cancelling any session now cascades to the linked sessions it started, not only a workflow's.
  - **Core.** `delegation.flow-unsupported` now only reports a workflow built with `Chain`, `Switch`, `Parallel`, `Map` or `Loop`. New helpers: `flowDelegatesOf`, `flowDelegateManifest`, `isFlowDelegate`; `delegatesOf` lists only the ReAct agents run in-process.

### Patch Changes

- 8cda500: **Workflow functions and tool steps reach the executor.** Several workflow nodes asked the executor for a key that core never registered, so the executor never found the function and the turn waited forever.

  - A Map's `over` and a slot's `input` now use the keys core registers (`<path>/over`, `<path>/input`), as Switch's `on` already did.
  - A slot `input` that wraps a Map or Switch gets its own effect id, so it no longer collides with the `over` or `on` effect on the same path.
  - A slot `id` that renames a nested workflow now renames the keys inside it too.
  - A verifier slot's `input` is keyed under the verifier's path (`<loop>/<part>/input`).
  - A tool step passes its output to the next step, not the `{ kind: "completed", output }` outcome around it. A denied tool call fails the flow with `tool.denied`.

## 0.7.0-beta

### Minor Changes

- a322696: **Derived principals** (optional Host feature `derived-principals`): a client that holds the admin key no longer needs to store an application key.

  - `admin.createTenant({ name, principals: ["babai"] })` registers each named principal by the hash of its derived key, and `admin.deriveTenantKey(tenantId, principalId)` (or `deriveTenantKey(adminKey, tenantId, principalId)`) recomputes the key when needed.
  - `POST /v1/admin/tenants` accepts `derivedPrincipals: [{ id, credentialHash }]`. Ids match `^[a-z][a-z0-9-]{0,31}$` and `studio` is reserved; duplicate ids or credentials answer `400`. A retried create must name the same principals.
  - `createTenant` with `principals` throws `incompatible_host` before sending anything to a Host without the feature.

- 844bff3: **Act for a person: `Nylorun-Subject` and `Nylorun-Scopes`.** An app server that holds the Tenant key can name the person each request is for, and the Runtime enforces it (optional Host feature `subject-headers`).

  - `client.as(subject, { scopes })` in `@nylorun/agents` sends both headers on every call, event streams included. Scopes: `agents:read`, `agents:write`, `sessions:own`, `vaults:own`, `tenant:settings`; default `["sessions:own"]`.
  - The Runtime limits a subject to the routes its scopes allow (`403 scope_required`) and to its own sessions and vaults: another owner's session, vault or sandbox is the same `404` as a missing one, including `PUT` on its session id (was `409`). Reset, config seed, executors, actions and the sandbox tool routes are open to no subject. Only application keys may send the headers.
  - The AG-UI handler calls the Runtime as each person and requires `subject-headers`; new optional `scopes` option. The host's `session()` parameters can no longer replace a session's id, agent or owner.
  - Core exports `SUBJECT_HEADER`, `SCOPES_HEADER`, `SUBJECT_SCOPES` and `parseSubjectHeaders`. Postgres Tenant schemas migrate to version 2 (an indexed session owner column).

  Requests without `Nylorun-Subject` are unchanged.

- a322696: **The session log now carries what a chat UI shows** (optional Host feature `transcript-events`).

  - `message.assistant` for each completed model step: `{ invocationId, text, toolCalls: [{ callId, name, input }], agent? }`.
  - `tool.completed` for an MCP or sandbox tool: `{ invocationId, callId, capabilityId, toolName, output }`, or `error: { code, message }` for a tool error.
  - Tool `action.pending` and `action.completed` events, and `delegation.started` / `delegation.completed`, carry the model's `callId` (and `invocationId` on actions).
  - Events are written in the transaction that completes the effect, so a replay writes none.
  - `@nylorun/core/contracts` adds payload schemas and `parseTranscriptEvent(event)`; `LiveEvent.payload` stays `unknown`.

  Fix: a tool with both `approval` and an `output` schema now pauses for approval. The Runtime validated its `interaction-required` result against the output schema and failed the tool with `tool.invalid-output`; `denied`, `interaction-required` and `deferred` results are no longer validated.

## 0.6.0-beta

### Minor Changes

- bf1c2da: **`nylorun dev --ephemeral` runs on the Docker stack, with a Tenant-level fixture model (breaking beta).**

  - `nylorun dev --ephemeral` creates a temporary Tenant through `@nylorun/admin` (no Project link written), seeds it from `.env` with the fixture model, opens Studio on it and runs the watcher; the Tenant is deleted with its active work cancelled when the watcher ends, Ctrl-C included. It needs a Runtime that advertises `tenant-fixture-model`.
  - `PUT /v1/tenant/config/seed` accepts `fixtureModel: true`, stored as Tenant setting `model.fixture`: that Tenant's model calls use the Runtime's fixture model while other Tenants on the Host keep theirs. `HOST_PROTOCOL` advertises the new optional feature `tenant-fixture-model` (`OPTIONAL_HOST_FEATURES` in `@nylorun/core/compatibility`); clients do not require it.
  - `startEphemeralRuntime()` keeps its signature but its Tenants live in memory instead of SQLite under the Host root; nothing survives `close()`.
  - Closing a Tenant waits for running advances at most the advance grace period (30 s by default) and then abandons them; their lease lapses and the next advance takes over.
  - A Worker stop, Tenant close or ended Restate attempt no longer fails or cancels the turn it interrupts: outcomes already returned are recorded, nothing is settled, and the next advance resumes the turn from its checkpoint. Only a user cancel settles `cancelled`; an advance deadline fails the turn with the deadline's message.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- bf1c2da: **Tenants are Postgres schemas only; SQLite and the `nylorun-runtime` launcher are removed (breaking beta).**

  - The Runtime runs on Postgres (the Session Store, one schema per Tenant), Restate (Durable Session Execution: one advance per session, fenced by an ownership epoch, and a per-Tenant sweep) and S2 (Durable Streams: every event is written to a Postgres outbox and relayed to the session's stream, which history and SSE read). `--role api|worker|all` selects the process role; `/ready` covers Postgres, Restate and S2.
  - SQLite Tenants are not migrated. On first start the Runtime moves every `tenants/<id>/` directory that holds a `tenant.sqlite` to `trash/<id>-sqlite-<time>/` and logs `sqlite_tenant_moved_to_trash`; recreate those Tenants.
  - `@nylorun/runtime` has no bin: the `nylorun-runtime` launcher and `host-state.json` are gone. The Runtime runs as the `ghcr.io/nylorun/runtime` image (`nylorun start`); its Host entry requires `NYLORUN_DATABASE_URL`.
  - `openTenantRuntime(config, hooks)` requires the Tenant's opened `store` and `envelope`; `OpenTenantRuntime` receives them from the Tenant store. `HostStateFile` is no longer exported.
  - `@nylorun/core`: `LAUNCHER_PROTOCOL` and the launcher error codes are removed; `QuarantineSchema` drops `locked`, `lockPath` and `lockPid`; `TenantStatusSchema.checks.sqlite` is now `checks.store`. `TenantStatusSchema` gains optional `execution` (stuck invocations) and `streams` (basin, outbox depth, relay lag); `HostAggregateSchema` gains optional `outboxDepth` and `relayLagMs`.

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

## 0.5.0-beta

### Minor Changes

- c49efed: **Runtime Clients and Admin API (supporting packages).**

  - **core:** `AdminStatusSchema`, Project-link schemas, `ERROR_CODES` (launcher codes include `platform_unsupported`, `launcher_failed`, `downgrade_refused`), `admin-status` feature, `newPrincipalId`, `compareVersions`.
  - **runtime:** `/v1/admin/status` (alias `/v1/admin/host`), loopback/`Origin`/content-type checks; the launcher ships as this package's `nylorun-runtime` bin (source under `src/launcher/`, not in `exports`) and runs the Host on the Node it runs on.
  - **studio:** `nylorun-studio` binary; connects via `resolveConnection`; waits for `dev`; never calls Admin API or writes `.nylorun/`.

  **Prerequisites:** developers install Node 24+ and `@nylorun/runtime` (`npm install --global @nylorun/runtime`) themselves; no package downloads Node or the Runtime, and there are no per-platform Runtime packages. Launcher commands: `version`, `up`, `down`, `restart`, `run`, `status`, `logs` (launcher protocol 1).

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

## 0.4.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

## 0.3.0-beta

### Minor Changes

- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- b8d822a: Let a running Runtime learn its executors instead of receiving them all at startup.
  `PUT /v1/executors` registers or rotates scoped executor credentials with the application
  credential, `DELETE /v1/executors/:agentId` removes one, and `GET /v1/executors` lists them
  without disclosing secrets. Registrations persist in SQLite with the token hashed at rest and
  are restored on the next start; scopes supplied through `NYLORUN_EXECUTORS_JSON` still apply
  to that process, take precedence for their agent, and are never written to the database. An
  unchanged registration is idempotent and keeps open streams, while a rotation ends the
  replaced token's work stream and stops it authorizing. Unauthenticated `/health` now also
  reports the Runtime version, a non-reversible scope digest of the database path, and the
  process id; all three are optional in the contract so an older host still parses. Token
  hashing is adequate only because these credentials are high-entropy values minted by the
  host; it is not a password derivation.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

## 0.2.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

## 0.1.0-beta.1

Initial package extraction.
