# @nylorun/cli

## 0.15.0-beta

### Major Changes

- 1345f61: **`nylo` ships in `nylorun`; `@nylorun/cli` is deprecated.** One package runs a project's local Tenant (`nylorun`) and is the Runtime client of the linked installation (`nylo`). MIGRATION.md ("`nylo` ships in `nylorun`") has the details.

  - `nylorun`: a second bin, `nylo` (`npx -p nylorun nylo <command>`), with the same commands, flags, output and exit codes as `@nylorun/cli`'s. The `nylorun` command never loads it. nylorun now depends on `@nylorun/admin`, which `nylo` uses. `nylo configure`'s provider sign-in comes from `@earendil-works/pi-ai` (about 100 MB with its provider SDKs), which is not a dependency: the first `nylo configure` installs the tested version into `~/.nylorun/lib/pi-ai-<version>/` with npm, without install scripts, unless it resolves beside nylorun, so `npx nylorun` stays about 11 MB. `nylorun configure`, `nylorun status --env` and `nylorun doctor sandbox` still exit 2, now naming `npx -p nylorun nylo …`. `nylorun status|reset` (the local Tenant's containers and volumes) and `nylo status|reset` (the Management API) keep their meanings; both usages and the README say which is which.
  - **Deprecated (`@nylorun/cli`):** its `nylo` prints one line on stderr and runs nylorun's `nylo` with the same arguments and exit code; stdout is unchanged, so `eval "$(npx @nylorun/cli env)"` still works. It depends on `nylorun` only. A later release removes it.
  - **Breaking (`@nylorun/admin`): the `./project` subpath is removed.** It re-exported `@nylorun/core/project` for `nylo`, which now imports Core directly. Import `@nylorun/core/project` instead.
  - `@nylorun/create-agent`: `compatibility.json` no longer pins `@nylorun/cli`; the examples run `nylo` from their `nylorun` devDependency.

### Patch Changes

- Pin nylorun to the tested release.
- Updated dependencies [554df94]
- Updated dependencies [1345f61]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - nylorun@0.13.0-beta

## 0.14.2-beta

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.19.1-beta
  - @nylorun/admin@0.14.1-beta

## 0.14.1-beta

### Patch Changes

- 7780b2f: **One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

  - `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
  - `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
  - `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
  - `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
  - `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
  - `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.19.0-beta
  - @nylorun/admin@0.14.0-beta

## 0.14.0-beta

### Major Changes

- 50e2f7e: **Protocol 10: MCP credentials come from a session's vaults only.** Nylorun no longer signs the installation in to MCP servers with OAuth and no longer asks a credential resolver. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): the MCP OAuth connect is gone.** `POST /v1/tenant/vaults/{vaultId}/oauth/start` and `GET /v1/oauth/callback` answer `404`. The vault credential type `oauth` and its refresh are gone: a credential is a `bearer` token or a `headers` map bound to a URL. Migration `0016_mcp_oauth_removed` drops the table of pending connects and deletes every `oauth` credential, writing one audit row each (actor `migration`); the Runtime logs `oauth_credential_removed` once for each, naming its vault, id and URL.
  - **Breaking (`@nylorun/runtime`): the credential resolver is gone.** The gateway no longer asks the operator's resolver for a person's credential when the session's vaults hold none. A process that still sets a `NYLORUN_RESOLVER_*` variable logs `resolver_removed` and ignores it. Keep a person's own keys in their user vault and attach it to their sessions (`vaultIds`). `TenantConfig.resolver`, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` export and `VaultService`'s `fetch` option are removed; `NYLORUN_PUBLIC_URL` still sets the protected resource metadata's `resource`.
  - **Breaking (`@nylorun/core`):** `PROTOCOL_VERSION` is 10 and `HOST_PROTOCOL` 4–10. `StartOAuthRequest`, `StartOAuthResponse`, the `oauth` variants of `CreateCredentialRequest` and `RotateCredentialRequest`, `oauth` in `CredentialInfo.type` and `CredentialInfo.expiresAt` are removed, and `ERROR_CODES` drops `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`. `@nylorun/agents` and `@nylorun/cli` send protocol 10.
  - **Breaking (`@nylorun/admin`):** `admin.vaults` loses its OAuth start method.
  - **Breaking (`nylorun`):** the `connect` subcommand of `nylorun mcp` is removed (`nylorun mcp inspect` lists a server's tools instead), and the gateway's Compose service no longer passes the `NYLORUN_RESOLVER_*` variables.
  - `@nylorun/studio`: the Credentials page loses the OAuth type, the Expires column and the OAuth connect hint.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [50e2f7e]
- Updated dependencies [fed5e58]
- Updated dependencies [da93711]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.18.0-beta
  - @nylorun/admin@0.13.0-beta

## 0.13.0-beta

### Major Changes

- cf5eb9c: **Protocol 9: the Runtime API is an OAuth 2.1 resource server for your identity provider's tokens.** Nylorun is still never the authorization server. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): a refused credential is `401`, not the opaque `404`.** No `Authorization` is `401 credential_required`; an unknown key, or a token no trusted issuer signed or that fails a check, is `401 credential_invalid`. Each carries `WWW-Authenticate: Bearer` (OAuth 2.1 §5.3), naming the protected resource metadata (`resource_metadata`) on the Runtime API when the Runtime has trusted issuers; the Management API's challenge is a bare `Bearer`. `token_expired` and `issuer_unavailable` gain the challenge too. Another Tenant named, a Tenant that could not open and an unsigned capability link stay the opaque `404`.
  - **Breaking (`@nylorun/runtime`): a request with neither `Nylorun-Protocol` nor `Authorization`** on an API route gets that route's `401` challenge instead of `426`, so a generic OAuth client learns where to sign in.
  - `@nylorun/runtime`: a token without a route's scope still gets `403 scope_required`, now with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. The `Bearer` scheme is matched in any case (RFC 9110).
  - `@nylorun/runtime`: `GET /.well-known/oauth-protected-resource` (RFC 9728) serves the resource (`NYLORUN_PUBLIC_URL`, else the request's origin), the identity file's issuers in order and their scopes, with no key or protocol; `404` without an identity file.
  - **Breaking (`@nylorun/runtime`): the identity file drops `maxLifetime`.** The issuer sets its tokens' lifetimes; `exp` is required, `iat` no longer is. A key the file does not define, `maxLifetime` included, is ignored and logged (`identity_file_key_ignored`) instead of stopping the boot. `subject` defaults to `{sub}`, `scopes` to `{ claim: scope }` and `allowedScopes` to every token scope but `studio`.
  - `@nylorun/core`: `PROTOCOL_VERSION` is 9 and `HOST_PROTOCOL` 4–9, with the required feature `resource-server`; `ERROR_CODES` adds `credential_required` and `credential_invalid`. `@nylorun/agents`, `@nylorun/admin` and `@nylorun/cli` send protocol 9.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [cf5eb9c]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.17.0-beta
  - @nylorun/admin@0.12.0-beta

## 0.12.1-beta

### Patch Changes

- cb29dea: **READMEs for manifest-only agents.** Documentation only; no code changes.

  - `@nylorun/agents`: the Flow agents example opens the PR with an `http()` tool stage instead of a code tool, and shows how to keep a person's approval: a flow stage cannot take `approval` yet (`flow.approval-unsupported`), so the HTTP tool goes to an agent stage with `approval: "always"`. Requests set `Nylorun-Protocol` 8. The subagents section says `ctx.state`, `ctx.agent` and `ctx.ask`/`ctx.approve` apply only to `tool({ run })` in the local engine.
  - `@nylorun/cli`: no longer says `nylo endpoints` uses the Runtime API or replaces `nylo tenant endpoints`; it was removed with Action endpoints and exits 2.

- Pin agents to the tested release.
- Updated dependencies [cb29dea]
  - @nylorun/agents@0.16.1-beta

## 0.12.0-beta

### Major Changes

- c135267: **Action endpoints are removed (manifest-only agents, M6).** The Runtime runs no code of yours during a session: an agent's tools are HTTP tools, remote MCP servers, agents used as tools and the Runtime's built-ins. Protocol stays 8; the `action-endpoints` feature is gone, so a client that requires it is refused. See MIGRATION.md, "Action endpoints are removed".

  - **Breaking (`@nylorun/core`):** the `Action`, endpoint (`PutEndpointsRequest`, `Endpoint`, `EndpointHealth`, …) and delivery schemas, `SIGNATURE_HEADER`, `OUTCOME_HEADER`, `DELIVERY_TOKEN_TYPE` and the `action.*` events (`action.pending`, `.delivered`, `.delivery_failed`, `.completed`, `.uncertain`) are removed, and `ToolDefinition.background` with them. `ActionOutcome` is renamed `EffectOutcome`. Tenant status loses `checks.endpoints`, `agents[].registered` and `agents[].endpoint`, and `counts.pendingActions`; the session view loses `actions`. A `turn.paused` interaction carries the tool call's `callId`. New `codeToolsOf` and `codeToolRefusal` name a definition's tools that would run your code. The Harness API is v2 (`HARNESS_API_VERSION = 2`): `TurnStart.options.holdMs` and `effect.resolved` are removed.
  - **Breaking (`@nylorun/harness`):** held runs are gone: `createHarness` loses `holdMs`, and `apiHost` its `hold` option.
  - **Breaking (`@nylorun/agents`):** `createActionHandler`, `executeAction`, `createActionSandbox`, `definitionDeclaresSandbox`, `isActionSandboxTool` and the `Action`, `ActionOutcome`, `ActionHandler`, `ActionHandlerOptions`, `RegisterOptions`, `ExecuteActionOptions` and `ExecutableDefinition` types are removed. `saveAgent` refuses a code tool (`tool({ run })`) or a flow tool stage before sending; its `implementationVersion` is optional (`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`).
  - **Breaking (`@nylorun/runtime`):** `/v1/endpoints` and `/v1/actions/*` answer `404`; delivery tokens, the deliverer, background tools, held runs (`TenantConfig.actionHoldMs`), `DurableExecution.deliver`, the Restate `NylorunAction` object, the `action_result` wake and the gates service's `/nylorun/v1/deliveries` are removed, and a migration drops the `actions` and `endpoints` tables. `PUT /v1/agents/:id` refuses a definition with a code tool or a flow tool stage (`400`); a tool the Runtime cannot run fails with `tool.unavailable`. The fixture model answers in text when the agent offers no `lookup_order` tool.
  - **Breaking (`@nylorun/cli`):** `nylo endpoints` is removed (a usage error that says why); `nylo status` shows uncertain effects instead of pending Actions.
  - **Breaking (`@nylorun/create-agent`):** the starter saves its agent with `saveAgent` and runs no server: no Action endpoint, `PORT` or `NYLORUN_ACTIONS_URL`. Its assistant has no tools, with a commented `http()` tool to start from.
  - `nylorun`: the local stack's comments speak of MCP servers and HTTP tools on this machine, not Action endpoints.
  - `@nylorun/studio`: the `action.*` event views and delivery status are removed; the chat shows `tool.completed`, and the Agent Manifest tab lists tools without a target as code tools.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [4bd2a0b]
- Updated dependencies [a64aaca]
- Updated dependencies [40b7648]
- Updated dependencies [713e676]
- Updated dependencies [c135267]
- Updated dependencies [d36f0d9]
- Updated dependencies [107b07d]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.16.0-beta
  - @nylorun/admin@0.11.1-beta

## 0.11.0-beta

### Minor Changes

- 3b3bdc6: **The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

  - `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
  - `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
  - `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
  - **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
  - `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.

- 7f763c3: **The Admin API and the operator listener are gone (Runtime and Management APIs, step A5).** Host work moves to the machine: `nylorun` runs `nylorun-operate` inside the runtime container, and every remote client uses the Runtime API or the Management API.

  - **Breaking (`@nylorun/runtime`):** `/v1/admin/*` (status, host, shutdown, keys, openapi.json) is removed; it answers like any unknown route. The operator listener, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS` and `host.json`'s `adminPort` are gone, and so is the `admin-openapi.json` package file. Stop the Host with SIGTERM. `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name, state and cause, exiting 2 when the Tenant is not open. `/ready` adds `harness: { mode, connected }` while the Tenant is open. `startEphemeralRuntime` loses `operatorListener` and `adminUrl`. The admin key stays: it derives Studio's key.
  - **Breaking (`@nylorun/admin`):** `createAdmin()` is the Management API client (`tenant`, `keys`, `models`, `vaults`, `signingKeys`, `settings`) with a management key: explicit `{ url, key }`, else `NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`, else the Project link's or the local Host root's management key. `status()`, `adminUrl`, the Admin API keys, `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY` and `OPERATOR_KEYS_FEATURE` are removed; `deriveStudioToken` and `mintStudioLoginToken` stay.
  - **Breaking (`@nylorun/core`):** `admin-status` leaves `PROTOCOL_FEATURES` (the Host still advertises it for protocol 5–7 clients) and `operator-keys` is removed; `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema` and `HostShutdownResponseSchema` are removed.
  - **Breaking (`nylorun`):** no admin port: `NYLORUN_ADMIN_PORT` is no longer written or published (an existing one is ignored). `nylorun start` waits for `/ready`, and `nylorun status` reads readiness from `/ready` and the Tenant from `nylorun-operate status`.
  - `@nylorun/cli`: `nylo status` no longer falls back to the Admin API; when the Tenant does not answer it points to `npx nylorun status`.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [a6108f4]
- Updated dependencies [b28bdd7]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.15.0-beta
  - @nylorun/admin@0.11.0-beta

## 0.10.0-beta

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

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.14.0-beta
  - @nylorun/admin@0.10.0-beta

## 0.9.0-beta

### Major Changes

- b352feb: **File artifacts, message parts and capability links (protocol 6).** Upgrade these with the Runtime: they speak protocol 6, which this Runtime serves beside 4 and 5. See MIGRATION.md.

  - **`@nylorun/runtime`: file artifacts.** A file is an artifact: an `af_` id, a name and numbered immutable versions, with rows in the new `artifacts` and `artifact_versions` tables (migration `0004_artifacts`) and bytes in the Object store (`BlobStore`). `POST /v1/artifacts?name=&sessionId=` uploads a file in one streamed request and `POST /v1/artifacts/{id}/versions` adds a version, within the Tenant's limits (`GET`/`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default); a body past either is `413 limit_exceeded`, refused mid-stream with nothing stored. `GET /v1/artifacts` lists them (by session), `GET /v1/artifacts/{id}` reads one with its versions, `GET /v1/artifacts/{id}/versions/{n|latest}/content` downloads through the Runtime with HTTP Range (`206`, `Content-Range`, `416`), and `DELETE /v1/artifacts/{id}` deletes it with its bytes. A session's artifacts go with it on a sessions reset, and appear in its history as `artifact.created`, `artifact.version.created` and `artifact.deleted` (new in the event catalog). A subject reaches only the artifacts of their own sessions.
  - **`@nylorun/runtime`: capability links.** `POST /v1/artifacts/{id}/links` mints a short-lived path, `/v1/artifact-links/<token>`, that downloads one version (with Range) with no credential and no `Nylorun-Protocol`: an ES256 JWT (`typ: nylorun-artifact+jwt`) signed with the Tenant's signing key, at most 15 minutes, and dead once the artifact is deleted. The Host logs its path without the token.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): message `parts`.** A user message may carry `parts`: `text`, and `file` by `artifactId` (and `version`, else the latest, pinned when the message is accepted). Model-gate reads the file from the Object store: an image goes to the model as image input, a text file as text, and any other file fails the call (`invalid_request`). The record and the transcript hold only the reference. The gateway builds its `BlobStore` from `NYLORUN_OBJECT_STORE_*` (the Tenant's `fs` store without it). `PROTOCOL_VERSION` is 6; `HOST_PROTOCOL` is 4–6 and protocol 6 clients require the feature `artifacts`.
  - **`@nylorun/runtime`: `save_artifact`.** A session with a sandbox gets the `nylorun.artifacts` capability, whose `save_artifact` tool saves a sandbox file (`path`) or text (`content`) as an artifact of the session, carrying the turn and tool call on its event.
  - **Breaking (`@nylorun/runtime`): `MediaStore` is removed.** `MediaStore` and `localMedia` leave `@nylorun/runtime/node`, and `piModel` takes `files` (a resolver from an artifact reference to its bytes) instead of `media`; images are file artifacts. The image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`) stay.
  - **`@nylorun/agents`:** `client.artifacts` (`upload`, `uploadVersion`, `list`, `get`, `download` with a range, `link`, `delete`), also on `BrowserClient`, and `session.inputParts(parts)`. A request with a body of its own type keeps it.
  - `@nylorun/admin`, `@nylorun/cli`, `nylorun`, `@nylorun/studio`: speak protocol 6.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [926711b]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.13.0-beta
  - @nylorun/admin@0.9.0-beta

## 0.8.0-beta

### Minor Changes

- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [4b9906f]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.12.0-beta
  - @nylorun/admin@0.8.0-beta

## 0.7.0-beta

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

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.11.0-beta
  - @nylorun/admin@0.7.0-beta

## 0.6.0-beta

### Minor Changes

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

- 50d0fb5: **Subject tokens: a person's own credential for the Runtime.** An app server mints a short-lived token for one signed-in person, and their app calls the Runtime directly (optional Host feature `subject-tokens`). Requests with application keys and subject headers are unchanged.

  - **Runtime.** `POST /v1/tokens` (application key only) mints an ES256 JWT for a subject and a role, valid 60–900 seconds. The Tenant API accepts it as a bearer and resolves its scopes and agents from the role on every request. Forged, foreign or malformed tokens get the opaque `404`; an expired token, a revoked subject, a revoked key or a removed role gets `401 token_expired` with `WWW-Authenticate`. Tokens carry only `agents:read`, `sessions:own` and `vaults:own`; they may not set session `info`, send `message.manifest` or store OAuth refresh credentials, and `GET /v1/agents` shows them `{ agentId, name, description }` of their role's agents only.
  - **Access policy.** `GET`/`PUT /v1/access/policy`: roles with token scopes, an agent allowlist and limits (`turnsPerHour`, `concurrentTurns`, answered with `429 limit_exceeded` and `Retry-After`). Without roles nothing is minted.
  - **Signing keys.** Per Tenant, the private key sealed with the vault KEK: `GET /v1/access/signing-keys`, `POST …/rotate` (refused while the previous key may still verify live tokens; `force` for incidents), `POST …/:kid/revoke`, `GET /v1/access/jwks`. A Tenant with signing keys and no KEK is quarantined `kek-missing`.
  - **Revocation.** `POST /v1/access/revocations` ends a subject's tokens; their open event streams end with `event: nylorun.closed` on every process. A stream opened with a token also ends when the token expires.
  - Postgres migration 3 adds `signing_keys`, `subject_epochs`, `subject_usage` and an index on the session owner and status. New error codes `token_expired` and `limit_exceeded`.
  - **Agents SDK.** `client.tokens.create()`, `client.access.getPolicy()`/`putPolicy()`/`revokeSubject()`/`jwks()` and `client.access.signingKeys.list()`/`rotate()`/`revoke()`, each checking the Host feature first.
  - **CLI.** `nylo access policy get|set|init`, `nylo access signing-keys list|rotate|revoke`, `nylo access revoke <subject>` and `nylo access token` for trying the API.

### Patch Changes

- f39b79f: **`nylo doctor sandbox` shows the Tenant's default sandbox**: `none`, `virtual`, or a Tenant sandbox that sessions naming no sandbox get.
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

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [c7614a4]
- Updated dependencies [5f23047]
- Updated dependencies [4282d5f]
- Updated dependencies [82d95ef]
- Updated dependencies [e28b8a9]
- Updated dependencies [50d0fb5]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [9546ac7]
- Updated dependencies [9d52189]
- Updated dependencies [9d52189]
- Updated dependencies [50d0fb5]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.10.0-beta
  - @nylorun/admin@0.6.0-beta

## 0.5.0-beta

### Minor Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

### Patch Changes

- Pin admin to the tested release.
- Updated dependencies [db956bc]
  - @nylorun/admin@0.5.0-beta

## 0.4.2-beta

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.9.0-beta
  - @nylorun/admin@0.4.1-beta

## 0.4.1-beta

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [42272f8]
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.8.0-beta
  - @nylorun/admin@0.4.0-beta

## 0.4.0-beta

### Minor Changes

- bf1c2da: **The local Runtime and Studio run as a Docker Compose stack that the CLI manages; Studio ships only as its image (breaking beta).**

  - `nylorun start` writes `<Host root>/stack/compose.yaml` and `.env` (mode 0600) and starts Postgres, Restate, s2-lite, the Runtime and Studio on loopback ports, with the Runtime and Studio images this CLI pins (`nylorun.runtime`, `nylorun.studio`; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them). `nylorun stop` keeps the volumes; `nylorun status [--json] [--env]` reports services and health; `nylorun reset [--yes]` deletes the volumes and every Tenant.
  - `nylorun dev` starts the stack if it is not running, creates the Project's Tenant on first run, opens Studio on that Tenant through a single-use login URL (`next=/tenants/<id>`), and runs the application with `NYLORUN_RUNTIME_URL=http://localhost:<port>`. `--no-open` prints the URL only; `--no-studio` skips Studio. `--local-ui` is removed (exit 2).
  - `nylorun logs` and `nylorun studio` are the stack commands (`nylorun stack <command>` still works). `nylorun studio` lands on the linked Project's Tenant.
  - `nylorun runtime up|down|restart|run|status|logs` and the `up`/`down` aliases are removed; they exit 2 and name `nylorun start|stop|status|logs`. `nylorun runtime status --env` is now `nylorun status --env`.
  - `nylorun doctor` checks Node 24+, Docker, Compose v2 and the stack's health; `doctor runtime` is an alias of it.
  - `@nylorun/studio` is private and ships only as `ghcr.io/nylorun/studio`: `startStudio`, the hosted (`local.nylorun.studio`) and local UI modes, pairing, the `nylorun-studio` bin and the UI bundle download are removed.
  - `npm create @nylorun/agent` no longer adds `@nylorun/studio` or a `studio` script, checks for Docker with Compose v2 instead of a global `@nylorun/runtime`, and accepts `--no-studio` only as a deprecated no-op.

- bf1c2da: **`nylorun dev --ephemeral` runs on the Docker stack, with a Tenant-level fixture model (breaking beta).**

  - `nylorun dev --ephemeral` creates a temporary Tenant through `@nylorun/admin` (no Project link written), seeds it from `.env` with the fixture model, opens Studio on it and runs the watcher; the Tenant is deleted with its active work cancelled when the watcher ends, Ctrl-C included. It needs a Runtime that advertises `tenant-fixture-model`.
  - `PUT /v1/tenant/config/seed` accepts `fixtureModel: true`, stored as Tenant setting `model.fixture`: that Tenant's model calls use the Runtime's fixture model while other Tenants on the Host keep theirs. `HOST_PROTOCOL` advertises the new optional feature `tenant-fixture-model` (`OPTIONAL_HOST_FEATURES` in `@nylorun/core/compatibility`); clients do not require it.
  - `startEphemeralRuntime()` keeps its signature but its Tenants live in memory instead of SQLite under the Host root; nothing survives `close()`.
  - Closing a Tenant waits for running advances at most the advance grace period (30 s by default) and then abandons them; their lease lapses and the next advance takes over.
  - A Worker stop, Tenant close or ended Restate attempt no longer fails or cancels the turn it interrupts: outcomes already returned are recorded, nothing is settled, and the next advance resumes the turn from its checkpoint. Only a user cancel settles `cancelled`; an advance deadline fails the turn with the deadline's message.

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.
- 1d84b3e: **Native Windows is no longer supported; Windows developers use WSL2.** Nylorun runs on macOS and Linux. On native Windows, `nylorun` and `npm create @nylorun/agent` stop with WSL2 guidance. Install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and keep projects in its Linux filesystem. The Windows-only process handling (`taskkill`, `.cmd` shims, `npm.cmd`) is removed. `nylorun doctor` reports WSL as `Linux (WSL: <distribution>)`.

### Patch Changes

- 1d84b3e: Opening the browser no longer crashes the CLI when no opener is installed (no `xdg-open` on a minimal Linux or WSL): it reports that and leaves the printed Studio URL to open by hand. Inside WSL, the CLI opens the Windows browser with `wslview`.
- Pin agents to the tested release.
- Pin admin to the tested release.
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.7.0-beta
  - @nylorun/admin@0.3.0-beta

## 0.3.0-beta

### Minor Changes

- c49efed: **Breaking (pre-1.0 minor):** CLI reaches the local Runtime only through the installed Runtime's launcher.

  - Dependencies: `@nylorun/agents` and `@nylorun/admin` only (no `@nylorun/runtime`, no `@nylorun/studio`).
  - `nylorun runtime …` finds `nylorun-runtime` on PATH and checks its launcher and Host protocol; a missing or incompatible Runtime exits 1 with the install command for the recommended version (`package.json` `nylorun.runtime`). Nothing is downloaded. `nylorun doctor runtime` checks the prerequisites.
  - `nylorun dev` runs the application entry under `tsx watch`; creates Tenants through `@nylorun/admin`.
  - **Removed:** `nylorun serve` and the in-process Project runner. `nylorun studio`
    remains the Project-aware Studio command, and `nylorun dev --no-studio`
    remains the headless development path.
  - Install as a **devDependency**; production `start` is `node dist/src/main.js`.

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.6.0-beta
  - @nylorun/admin@0.2.0-beta

## 0.2.1-beta

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [1cd7dc7]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.5.0-beta
  - @nylorun/runtime@0.9.0-beta

## 0.2.0-beta

### Minor Changes

- b8d822a: Remove `nylorun start`. The compiled agent process is now `nylorun serve [entry]`, with the
  same `dist/agents/index.js` default, and generated projects must change `scripts.start` to
  `nylorun serve`. The local Runtime becomes a persistent process of its own under
  `nylorun runtime start|stop|status|logs`, with `nylorun up` and `nylorun down` as aliases.
  `dev` and `serve` attach to that Runtime, start one when nothing is listening, and leave it
  running, so a watch restart re-registers agents and reconnects executors instead of
  destroying in-flight sessions; `--no-autostart` fails instead and is what continuous
  integration should use. Scope is per project by default in `.nylorun/`, created on first use,
  with `--global` and `NYLORUN_HOME` for a shared Runtime in the home directory. Commands
  report a resolved scope in every message, accept `--port` and `--db` alongside the existing
  environment variables, expose `nylorun runtime status --output json`, and use documented exit
  codes for usage errors, port conflicts, version skew, refused autostart and failed starts.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.4.0-beta
  - @nylorun/runtime@0.8.0-beta

## 0.1.2-beta

### Patch Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.3.0-beta
  - @nylorun/runtime@0.7.0-beta

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.2.0-beta
  - @nylorun/runtime@0.6.0-beta

## 0.1.0-beta.1

Initial package extraction.
