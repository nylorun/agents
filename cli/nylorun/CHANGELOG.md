# nylorun

## 0.13.0-beta

### Minor Changes

- 1345f61: **`nylo` ships in `nylorun`; `@nylorun/cli` is deprecated.** One package runs a project's local Tenant (`nylorun`) and is the Runtime client of the linked installation (`nylo`). MIGRATION.md ("`nylo` ships in `nylorun`") has the details.

  - `nylorun`: a second bin, `nylo` (`npx -p nylorun nylo <command>`), with the same commands, flags, output and exit codes as `@nylorun/cli`'s. The `nylorun` command never loads it. nylorun now depends on `@nylorun/admin`, which `nylo` uses. `nylo configure`'s provider sign-in comes from `@earendil-works/pi-ai` (about 100 MB with its provider SDKs), which is not a dependency: the first `nylo configure` installs the tested version into `~/.nylorun/lib/pi-ai-<version>/` with npm, without install scripts, unless it resolves beside nylorun, so `npx nylorun` stays about 11 MB. `nylorun configure`, `nylorun status --env` and `nylorun doctor sandbox` still exit 2, now naming `npx -p nylorun nylo …`. `nylorun status|reset` (the local Tenant's containers and volumes) and `nylo status|reset` (the Management API) keep their meanings; both usages and the README say which is which.
  - **Deprecated (`@nylorun/cli`):** its `nylo` prints one line on stderr and runs nylorun's `nylo` with the same arguments and exit code; stdout is unchanged, so `eval "$(npx @nylorun/cli env)"` still works. It depends on `nylorun` only. A later release removes it.
  - **Breaking (`@nylorun/admin`): the `./project` subpath is removed.** It re-exported `@nylorun/core/project` for `nylo`, which now imports Core directly. Import `@nylorun/core/project` instead.
  - `@nylorun/create-agent`: `compatibility.json` no longer pins `@nylorun/cli`; the examples run `nylo` from their `nylorun` devDependency.

### Patch Changes

- 554df94: **Fixes for the one client layer.**

  - `@nylorun/admin`: `createAdmin` reads the Project link only in its local-Host step. Explicit `url` and `key`, or `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY`, no longer fail on a `.nylorun/link.json` that cannot be read (EACCES for a root-owned file after `sudo npx nylorun start`, EISDIR); the local-Host step refuses such a link, naming it, as it refuses a broken one (when nothing else names the Host root).
  - `@nylorun/admin`: a refusal without the Runtime's rejection body takes its code from the status: `invalid_request` (400), `credential_invalid` (401), `not_found` (404), `unsupported_media_type` (415), `internal_error` (5xx), else `request_rejected`; it was always `not_found`. Studio's own answers (`{ message }`, from its server and proxy, such as "This Studio session is invalid or has expired.") keep their message instead of one naming only the request and the status.
  - `nylorun`: `start` refuses Project or Host root credentials in a newer format than it reads ("Upgrade nylorun"), as it refuses a newer link, instead of replacing them with new keys in its own format.

- Pin admin to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [554df94]
- Updated dependencies [1345f61]
  - @nylorun/admin@0.15.0-beta

## 0.12.2-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [212364b]
  - @nylorun/core@0.19.0-beta

## 0.12.1-beta

### Patch Changes

- 7780b2f: **One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

  - `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
  - `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
  - `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
  - `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
  - `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
  - `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [7780b2f]
- Updated dependencies [070674d]
  - @nylorun/core@0.18.0-beta

## 0.12.0-beta

### Major Changes

- 50e2f7e: **Protocol 10: MCP credentials come from a session's vaults only.** Nylorun no longer signs the installation in to MCP servers with OAuth and no longer asks a credential resolver. Upgrade every package together; MIGRATION.md has the details.

  - **Breaking (`@nylorun/runtime`): the MCP OAuth connect is gone.** `POST /v1/tenant/vaults/{vaultId}/oauth/start` and `GET /v1/oauth/callback` answer `404`. The vault credential type `oauth` and its refresh are gone: a credential is a `bearer` token or a `headers` map bound to a URL. Migration `0016_mcp_oauth_removed` drops the table of pending connects and deletes every `oauth` credential, writing one audit row each (actor `migration`); the Runtime logs `oauth_credential_removed` once for each, naming its vault, id and URL.
  - **Breaking (`@nylorun/runtime`): the credential resolver is gone.** The gateway no longer asks the operator's resolver for a person's credential when the session's vaults hold none. A process that still sets a `NYLORUN_RESOLVER_*` variable logs `resolver_removed` and ignores it. Keep a person's own keys in their user vault and attach it to their sessions (`vaultIds`). `TenantConfig.resolver`, `TenantConfig.publicUrl`, `TenantConfig.vaultFetch`, `startEphemeralRuntime({ resolver })`, the `ResolverConfig` export and `VaultService`'s `fetch` option are removed; `NYLORUN_PUBLIC_URL` still sets the protected resource metadata's `resource`.
  - **Breaking (`@nylorun/core`):** `PROTOCOL_VERSION` is 10 and `HOST_PROTOCOL` 4–10. `StartOAuthRequest`, `StartOAuthResponse`, the `oauth` variants of `CreateCredentialRequest` and `RotateCredentialRequest`, `oauth` in `CredentialInfo.type` and `CredentialInfo.expiresAt` are removed, and `ERROR_CODES` drops `oauth_client_required`, `oauth_state_invalid` and `oauth_failed`. `@nylorun/agents` and `@nylorun/cli` send protocol 10.
  - **Breaking (`@nylorun/admin`):** `admin.vaults` loses its OAuth start method.
  - **Breaking (`nylorun`):** the `connect` subcommand of `nylorun mcp` is removed (`nylorun mcp inspect` lists a server's tools instead), and the gateway's Compose service no longer passes the `NYLORUN_RESOLVER_*` variables.
  - `@nylorun/studio`: the Credentials page loses the OAuth type, the Expires column and the OAuth connect hint.

### Minor Changes

- da93711: **Preview an MCP server's tools** (R2b C12). MIGRATION.md (protocol 10, "Previewing a server's tools") has the details.

  - `@nylorun/core`: `McpPreviewRequestSchema` and `McpPreviewSchema` (`McpPreviewTool`), and the error code `mcp_preview_failed`.
  - `@nylorun/runtime`: `POST /v1/tenant/mcp/preview` (the Management API) connects to a remote MCP server with the installation vault's credential for its URL (headers and `via`, no identity header), under the Host's address policy and within 15 s, and answers its server info, instructions, tools (model names, annotations, schema sizes) and renames; a `401` is `authRequired`, with the server's RFC 9728 protected-resource metadata. It runs in the keys service (`Keys.previewMcp`), which holds the plaintext, and calls no tool. Both OpenAPI documents list it.
  - `@nylorun/admin`: `admin.mcp.preview({ url, type?, name?, vaultId? })`.
  - `nylorun`: `nylorun mcp inspect <url> [--server <name>] [--vault <id>] [--sse] [--json]` prints the running Tenant's preview: a table of tools, the renames, or that the server needs a person's sign-in. Its `connect` subcommand still says it was removed, and now points to `inspect`.
  - `@nylorun/studio`: **Preview tools** on each credential of the Credentials page lists the tools behind its URL.

### Patch Changes

- fed5e58: **Docs: reaching a person's accounts** (R2b C5). The READMEs describe MCP credentials as protocol 10 has them (a `bearer` token or a `headers` map per URL, with `via` and an identity header for an MCP gateway), and point to "MCP servers and HTTP tools" in DEPLOYMENT.md: the operator's flow from credential to preview, tool settings, deferral, stored results and the error codes a model sees, with gateway recipes for Arcade, ToolHive, Obot and Nylorun Cloud and the proxy pattern for gateways that mint per person. `HttpToolTarget.credential`'s doc (`@nylorun/core`) no longer names the removed credential resolver.
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [50e2f7e]
- Updated dependencies [e0e39ff]
- Updated dependencies [fed5e58]
- Updated dependencies [18f9a2f]
- Updated dependencies [da93711]
- Updated dependencies [90a817d]
- Updated dependencies [b8d10cb]
  - @nylorun/core@0.17.0-beta

## 0.11.2-beta

### Patch Changes

- 6711320: `/ready` no longer checks S2: its `checks` cover the listener, the Tenant, Postgres and Restate, and an unreachable S2 leaves it `200`. S2 only serves API listeners (history, SSE, AG-UI and A2A), so an outage degrades those reads and never makes the Runtime unready. S2's reachability stays in the Tenant's status (`GET /v1/tenant`, `streams.reachable`).
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [cf5eb9c]
- Updated dependencies [2ed5fe0]
  - @nylorun/core@0.16.0-beta

## 0.11.1-beta

### Patch Changes

- Pin runtime to the tested release.
- Pin studio to the tested release.

## 0.11.0-beta

### Minor Changes

- 713e676: **Remote MCP servers only (blueprint D47).** Nylorun accepts `streamable-http` and `sse` MCP servers, declared by URL and reached through the gates; stdio servers and plugin roots are gone. See MIGRATION.md.

  - **Breaking (`@nylorun/core`):** `McpServerManifest` and the manifest schema keep only `streamable-http` and `sse`. A `stdio` server is refused by `.mcp({...})` (`McpError`, code `mcp.stdio`), by `Agent.from` and by the wire schema, all with one message (`stdioMcpRefusal`): "MCP server 'x' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL." `PutAgentRequest` loses `pluginRoots`, `CapabilityDeclaration` loses `pluginRoot`, and the Harness API's `RunRouting` loses `pluginRoots`.
  - **Breaking (`@nylorun/agents`):** `.plugin()` and `plugin()` throw `PluginError` (code `plugin.mcp-stdio`) for a stdio server in a plugin's `mcp.json`; its remote servers and skills load as before. `saveAgent` no longer sends plugin roots. `prepareStdioLaunch`, `expandPluginPlaceholders` and `StdioLaunch` are removed.
  - **Breaking (`@nylorun/runtime`):** no stdio MCP launcher: `PUT /v1/agents/:id` refuses a stdio server (`400`) and `pluginRoots`. `TenantConfig.childEnv`, `TenantPaths.pluginData` and `tmp`, `tenantChildEnvironment`, `startEphemeralRuntime({ baseline })` and `configForFactory`'s `baseline` and `hostConfig` are removed; the harness service no longer takes `childEnv` or `paths.pluginData`.
  - `nylorun`: the local stack no longer mounts the Host root's `plugins/` into the runtime and harness containers, nor the Tenant's `plugin-data/`, `home/` and `tmp/` into the harness, which now mounts only `sandboxes/`.

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

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [4bd2a0b]
- Updated dependencies [a64aaca]
- Updated dependencies [40b7648]
- Updated dependencies [713e676]
- Updated dependencies [c135267]
- Updated dependencies [d36f0d9]
- Updated dependencies [107b07d]
  - @nylorun/core@0.15.0-beta

## 0.10.0-beta

### Major Changes

- 7f763c3: **The Admin API and the operator listener are gone (Runtime and Management APIs, step A5).** Host work moves to the machine: `nylorun` runs `nylorun-operate` inside the runtime container, and every remote client uses the Runtime API or the Management API.

  - **Breaking (`@nylorun/runtime`):** `/v1/admin/*` (status, host, shutdown, keys, openapi.json) is removed; it answers like any unknown route. The operator listener, `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST`, `NYLORUN_ADMIN_ALLOWED_HOSTS` and `host.json`'s `adminPort` are gone, and so is the `admin-openapi.json` package file. Stop the Host with SIGTERM. `nylorun-operate status [--json]` reports the version, protocol and the Tenant's id, name, state and cause, exiting 2 when the Tenant is not open. `/ready` adds `harness: { mode, connected }` while the Tenant is open. `startEphemeralRuntime` loses `operatorListener` and `adminUrl`. The admin key stays: it derives Studio's key.
  - **Breaking (`@nylorun/admin`):** `createAdmin()` is the Management API client (`tenant`, `keys`, `models`, `vaults`, `signingKeys`, `settings`) with a management key: explicit `{ url, key }`, else `NYLORUN_RUNTIME_URL` + `NYLORUN_MANAGEMENT_KEY`, else the Project link's or the local Host root's management key. `status()`, `adminUrl`, the Admin API keys, `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY` and `OPERATOR_KEYS_FEATURE` are removed; `deriveStudioToken` and `mintStudioLoginToken` stay.
  - **Breaking (`@nylorun/core`):** `admin-status` leaves `PROTOCOL_FEATURES` (the Host still advertises it for protocol 5–7 clients) and `operator-keys` is removed; `AdminStatusSchema`, `AdminHostStatusSchema`, `HostAggregateSchema` and `HostShutdownResponseSchema` are removed.
  - **Breaking (`nylorun`):** no admin port: `NYLORUN_ADMIN_PORT` is no longer written or published (an existing one is ignored). `nylorun start` waits for `/ready`, and `nylorun status` reads readiness from `/ready` and the Tenant from `nylorun-operate status`.
  - `@nylorun/cli`: `nylo status` no longer falls back to the Admin API; when the Tenant does not answer it points to `npx nylorun status`.

### Minor Changes

- 3b3bdc6: **The clients use management keys (Runtime and Management APIs, step A3).** The protocol stays at 7; every client keeps working against a protocol 7 Runtime's routes.

  - `nylorun`: `nylorun start` keeps an application key (`project`) and a management key (`project-management`) for a Project, in `<Host root>/project-credentials.json` and the Project's `.nylorun/credentials.json` (still format 1, with new `managementKey` and `managementPrincipalId` fields). A credentials file holding only an application key gains a management key at the next start. Commands outside a project keep `cli` and `cli-management`. Keys are issued through `nylorun-operate` in the runtime container instead of the Admin API, and `nylorun key put <id> --management` puts a management key. Seeding the Tenant and `nylorun mcp connect` use the management key (`/v1/tenant/vaults`). Studio reaches the Runtime's public listener.
  - `@nylorun/cli`: `status`, `reset`, `configure`, `doctor` and `access signing-keys` use the Management API through `@nylorun/admin` with the Project's management key, or `NYLORUN_MANAGEMENT_KEY`.
  - `@nylorun/studio`: local Studio needs no login. A request on the published loopback address (`localhost` or `127.0.0.1` at Studio's port) acts as signed in; hosts behind a sign-in proxy and embedding keep their login, and state-changing requests still need Studio's own `Origin`. Studio learns its Tenant from `GET /v1/tenant` with its key instead of the Admin API, and its Connections page manages vaults through `@nylorun/admin/client` at `/v1/tenant/vaults`.
  - **Breaking (`@nylorun/admin`, `@nylorun/runtime`): Studio's key is derived from the admin key alone.** `deriveStudioToken(adminKey)` takes no Tenant id (HMAC-SHA256 over `nylorun/studio/v2`). The Host registers the new key's hash at its next start, replacing the old one; an app that embeds Studio and derives its key must update.
  - `@nylorun/core`: `ProjectCredentialsFileSchema` gains optional `managementKey` and `managementPrincipalId`.

### Patch Changes

- b28bdd7: **Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
  - `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
  - `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
  - `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.

- 7a22f7f: **`nylorun start` opens no browser.** `start` (and `up`) prints the Runtime and Studio URLs, says to run `nylorun studio` to sign a browser in to Studio, and ends with a pointer to `nylorun --help`. It no longer mints a Studio login token or opens Studio, also in a terminal. `--no-open` is still accepted and ignored. `nylorun studio` signs a browser in as before.
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
- Updated dependencies [c66d8ed]
  - @nylorun/core@0.14.0-beta

## 0.9.0-beta

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

- b906050: **Studio for a team (F9 S1).** Studio can sit behind a sign-in proxy such as oauth2-proxy. A request with no Studio session that carries a JWT, in `X-Forwarded-Access-Token` or as an `Authorization` bearer that is not a Studio session, signs in when the Runtime's `GET /v1/me` verifies it and reports the `studio` scope: Studio sets its usual signed session cookie, which records the subject for its write log and ends no later than the token (at most the usual 30 days), and serves the request. Studio never trusts the header unverified and keeps nothing else. A token without the scope gets `403` naming `studio`; a token the Runtime refuses, or one that is not a JWT, gets `401`. Admitted people get Studio's Tenant-wide view; the CLI sign-in and embedding are unchanged, and a valid embed bearer session still wins. New `NYLORUN_STUDIO_ALLOWED_HOSTS`: extra `Host` values Studio serves, comma-separated (`studio.acme.dev`); its state changes accept that host's `https` and `http` origins, and the cookie is `Secure` when the proxy sends `X-Forwarded-Proto: https`. The default is unchanged: only `localhost` and `127.0.0.1` on the published port. `nylorun start` passes `NYLORUN_STUDIO_ALLOWED_HOSTS` from its environment to the Studio container.
- c0b604e: **Trusted issuers (F9 I2).** The Tenant API accepts JWTs from the operator's own identity provider as bearers, configured in an identity file: `NYLORUN_IDENTITY_FILE` names a YAML file listing each issuer's `name`, `issuer`, `audience`, `jwks` URL or static PEM `keys`, a `subject` template over scalar claims (`u:{sub}`), `scopes` from a claim or a fixed list, `allowedScopes`, an optional `agents` allowlist, optional `sandboxes` grant templates (`{org_id}/*`) and `maxLifetime`. A malformed file stops the boot, naming the issuer and the field; a subject template without a claim is malformed. A bearer whose unverified `iss` names an issuer is verified with RS256, ES256 or EdDSA only, up to 16 KiB, `aud` matching, `exp` and `iat` required and `exp − iat` within `maxLifetime`, and becomes a token caller (`role: issuer:<name>`) with the issuer's scopes, agents and rendered sandbox grants; subject revocation does not reach it. JWKS keys are fetched only from the configured URL (no redirects), cached by `kid`, refetched at most once a minute for an unknown `kid`; while a JWKS is unreachable cached keys keep working and a new `kid` is `401 issuer_unavailable` (new error code). A browser request with an issuer token needs no publishable key (CORS comes from the operator's proxy). New: `GET /v1/me` reports the subject, scopes, agents, sandbox grants and `via` (`application:<id>`, `subject`, `token` or `issuer:<name>`) of any credential; the issuer-only scope `studio`; `ISSUER_SCOPES`, `CALLER_SCOPES` and `MeResponseSchema` in `@nylorun/core/contracts`; `parseIdentityFile` and `createTrustedIssuers` in `@nylorun/runtime`, and an `issuers` option on `startEphemeralRuntime`; Host feature `trusted-issuers` (additive, protocol unchanged). `nylorun start` sets `NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml` on the runtime container when `<Host root>/identity.yaml` exists.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.8.0-beta

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

- e58e6ec: **egress-gate: pod sandboxes reach only the hosts their spec allows (F7.2).** A new `egress` service runs in the gateway's process (`--service gates,keys,egress`) on `NYLORUN_EGRESS_LISTEN_PORT` (default 4200). It is a CONNECT proxy: each tunnel needs an egress token (`Proxy-Authorization`, Basic with the token as password or Bearer) for a live sandbox at its current host epoch, a host name (no IP literal) that the sandbox's `network.allow` names exactly or by `*.suffix`, port 443 or 80, and a name that resolves to a public address; the gate connects to that checked address and pipes bytes, with no TLS interception and no credential injection. Plain HTTP is answered `405`; a sandbox holds at most 64 tunnels; idle tunnels close after 5 minutes; refusals are logged, never emitted as events. Egress tokens (`typ: nylorun-egress+jwt`), minted with each host token at a pod's join, are accepted nowhere else; egress-gate also refuses a token of a sandbox that is deleted, lost or expired, or of a pod other than the one that joined. Sandbox spec resolution lets `pod` sandboxes allow `*.suffix` hosts within the Tenant's ceiling (virtual ones keep exact names). With sandboxes enabled, `nylorun` runs the gateway with `egress` and publishes it on `NYLORUN_SANDBOX_BIND` at `NYLORUN_SANDBOX_EGRESS_PORT`, next to the gates.
- 186ec3f: **A local Tenant has an Object store: RustFS, behind the Runtime's new `BlobStore` seam.** `nylorun start` adds a `rustfs` container (RustFS 1.0.1, single node and single drive, pinned by digest) on the `nylorun-<tenant>-rustfs` volume, unpublished and without its console. Its secret key is generated once into `docker/.env` (`NYLORUN_OBJECT_STORE_SECRET_KEY`), and only the `runtime` and `gateway` containers receive the credential (`NYLORUN_OBJECT_STORE_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`); the runtime creates the bucket at boot. The Runtime reaches the store through `BlobStore` (put with a streamed body and a size cap, get with a byte range, head, delete, list by prefix) with an `s3` adapter over the plain S3 API and an `fs` adapter, which a Runtime without `NYLORUN_OBJECT_STORE_ENDPOINT` (embedded, ephemeral, tests) uses under the Tenant directory's `blobs/`. Nothing stores files there yet; file artifacts build on it.
- 3fd1cda: **The harness container, the network split, and Restate's UI closed by default (F6.2).** A local Tenant now runs agent turns, stdio MCP servers and workspaces in a `harness` container: the runtime image as `--service harness`, connected to the runtime's Harness API (`ws://runtime:4200/nylorun/harness/v1`, `NYLORUN_HARNESS=remote`) with `NYLORUN_HARNESS_TOKEN`, which `nylorun start` generates once and keeps in `.env`. The harness holds no other credential, mounts only the Tenant directory's `sandboxes/`, `plugin-data/`, `home/` and `tmp/` under `/harness`, publishes no port and is healthy once connected; `nylorun status` and `nylorun doctor` report it, and `nylorun logs harness` shows its log. `NYLORUN_HARNESS=in-process` in `.env` rolls back to turns in the runtime container (the harness service is then removed).

  - Plugin roots: the Host root's `plugins/` directory is mounted read-only at its own path into the harness and runtime containers, so a stdio MCP server from a plugin under `~/.nylorun/tenants/<name>/plugins/` runs in the harness.
  - Networks: `<project>-store` (internal) joins Postgres, s2-lite, Restate and RustFS to the runtime and the gateway only; `<project>-harness` joins the harness to the runtime and the gateway only; the default network keeps egress and the published ports.
  - Restate's admin API and UI (unauthenticated) are no longer published. `nylorun start --restate-ui` (or `NYLORUN_RESTATE_UI=1`) publishes them on loopback for that start and prints the URL.

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

- db045cd: **The sandboxes service and `nylorun sandbox enable` (F7.2, first part).** A new image, `ghcr.io/nylorun/sandboxes`, versioned with the Runtime, drives agent-sandbox v1.0.5 Sandboxes in one namespace per Tenant: `PUT`, `GET ?wait=` and `DELETE /v1/pods/{name}` with an operation id, `/ready` and `/v1/info`, behind a bearer token only the runtime container holds. `nylorun sandbox enable --context <name>` installs into that kubeconfig context only (the pinned controller when absent, the namespace `nylorun-sbx-<tenant>`, a ServiceAccount whose Role covers Sandbox lifecycle and join Secrets, no NetworkPolicy or exec rights), refuses a cluster whose NetworkPolicy it cannot prove enforced, records `<Host root>/sandboxes/cluster.json` and the token, and adds the `sandboxes` service to the Tenant; `nylorun sandbox disable` and `nylorun sandbox status` remove and report it. Sessions do not run in pods yet: that comes with the Harness API and egress-gate.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.7.0-beta

### Minor Changes

- 9af30d8: **The Studio proxy is removed, and Restate runs with its own memory defaults.** Each Tenant's Studio is at `http://localhost:<port>` again (`nylorun studio --tenant <name>` opens it signed in): its own session cookie already keeps it apart from other Studios, so the proxy only added a container and a second address. The 256 MiB RocksDB cap did not lower Restate's memory, so it is gone. The first command of this release removes the proxy that 0.6 started (`nylorun-proxy` and `~/.nylorun/proxy/`); `NYLORUN_PROXY_PORT`, `NYLORUN_PROXY_DISABLED`, `studio.proxyUrl` and Studio's `NYLORUN_STUDIO_PUBLIC_ORIGINS` are gone.

### Patch Changes

- Pin studio to the tested release.

## 0.6.0-beta

### Minor Changes

- 0cbd5c9: **Breaking (`nylorun`): readable Docker names, several Tenants on one machine, and Studio at `http://<name>.localhost:4160`.** See MIGRATION.md.

  - **Breaking (`nylorun`): names.** Every container, the network and every volume carries the Tenant's Compose project: containers `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-gateway`, `-runtime`, `-studio` (were `…-1`), network `nylorun-<name>` (was `nylorun-<name>_default`), volumes `nylorun-<name>-postgres`, `-restate`, `-s2-lite`, `-workspaces` (were `nylorun-<name>_postgres`, …), each labelled `dev.nylorun.tenant: <name>`. The Compose service `s2` is now `s2-lite` (`nylorun logs s2-lite`).
  - **Breaking (`nylorun`): Tenants created by 0.5 start fresh.** `start` on a Tenant whose data is in the old volumes exits 3 without starting it and names them; `nylorun reset --tenant <name>` starts it anew. `reset` and `delete` also remove the old volumes and the old network.
  - **Studio proxy.** One Caddy container per machine (`nylorun-proxy`, files in `~/.nylorun/proxy/`) gives each Tenant's Studio the address `http://<name>.localhost:<port>` (`NYLORUN_PROXY_PORT`, 4160 or a free port chosen once), on `127.0.0.1` and `[::1]` (IPv4 only, saying so, when Docker refuses `::1`). It holds no Tenant data and routes browsers only. `start` brings it up when Studio starts, prints Studio's proxy URL and signs in there (on Studio's own port when the proxy does not answer); a proxy failure never fails `start`. `status` shows both URLs, `ls` and `nylorun studio` the proxy's. `NYLORUN_PROXY_DISABLED=1` turns it off; a Tenant under `NYLORUN_HOME` or `NYLORUN_COMPOSE_PROJECT` does not use it. `doctor` has a `proxy` row.
  - **Several Tenants.** Restate's RocksDB memory is capped at 256 MiB, so a Tenant uses about 600–700 MB (was about 1.3 GB). `nylorun ls` has a `MEMORY` column (`memoryBytes` in `--json`). `start` names the other running Tenants and their memory. `nylorun stop --all` stops every running Tenant and the proxy, keeping their volumes.
  - **`@nylorun/studio`.** `NYLORUN_STUDIO_PUBLIC_ORIGINS` lists exact `http:` origins Studio also serves (Host and `Origin` checks); a login token's URL is on the origin it was minted on; `NYLORUN_STUDIO_SESSION_COOKIE` names the session cookie (default `nylorun_studio_session`; `nylorun` sets `nylorun_studio_<name>`, so Studios on one host keep their own sessions); the `421` answer lists the served origins.

### Patch Changes

- Pin runtime to the tested release.
- Pin studio to the tested release.

## 0.5.0-beta

### Minor Changes

- f96fe32: **Studio reports anonymous page views, unless you opt out.** Studio sends page views to Google Analytics with every Tenant, agent and session id replaced by `:id` and the query dropped; nothing sent to agents is collected. `nylorun start` says so once, and passes the measurement id to the Studio container as `NYLORUN_STUDIO_ANALYTICS_ID`. Turn it off with `nylorun telemetry disable`, `NYLORUN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; it is always off in CI, inside an embedding app, and when the browser sends Do Not Track or Global Privacy Control.
- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [4b9906f]
  - @nylorun/core@0.11.0-beta

## 0.4.0-beta

### Major Changes

- 5ca1923: **Clients for one Tenant per installation: a stack per project, nothing selects a Tenant.** Upgrade these with the Runtime; they speak protocol 5. Existing stacks are left as they are: see MIGRATION.md.

  - **Breaking (`nylorun`): one stack per project.** `nylorun start` in a project creates the project's stack (named after the project directory, or `--name`; Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, its own free ports and volumes), waits for its Runtime to create the stack's Tenant, writes the Project link (`.nylorun/link.json` format 2: `stack`, `hostUrl`, `hostId`, `tenantId`) and `.nylorun/credentials.json` (the key of the derived principal `project`, derived from the stack's admin key), and seeds the model provider from the project's `.env`. `nylorun ls` lists the machine's stacks and `nylorun delete <name>` removes one with its volumes and Host root. `nylorun status` shows the stack's Tenant; `nylorun studio` opens it. The old single stack under `~/.nylorun` is never touched: `start` notes it, and `nylorun legacy stop|delete` handles it. Every stack command takes `--name <stack>` (or `NYLORUN_STACK`, or the Project link's stack); `start --no-link` starts a stack without linking the directory; `nylorun reset` resets the selected stack only. The runtime container's healthcheck is now `/health`, so a Tenant that cannot open is reported by `start` from the Admin status at once instead of after a 300 s wait. `NYLORUN_HOME` still overrides the Host root. Stacks start and stop only when you say so.
  - **Breaking (`@nylorun/cli`): no Tenant commands.** `nylo tenant create|use|list|current|delete` are removed; `nylo status`, `nylo reset` and `nylo endpoints` replace `nylo tenant status|reset|endpoints` on the linked installation. `nylo env` prints `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` only. `nylo` no longer writes Project links.
  - **Breaking (`@nylorun/agents`): no Tenant to name.** The `tenant` option (`createClient`, `Transport`, `resolveConnection`, `createActionHandler({ runtime })`, `JwksCache`) and `NYLORUN_TENANT` are gone, and no request sends `Nylorun-Tenant`; a connection is a URL and a key. A Project link of format 0 or 1 is refused with `connection_missing`, naming `npx nylorun start`. `verifyDeliveryToken`'s `tenantId` is optional: without it any Tenant issuer is accepted, since the installation's keys bind it. `TENANT_HEADER` is no longer re-exported.
  - **Breaking (`@nylorun/admin`): status only.** `createTenant`, `listTenants`, `getTenant` and `deleteTenant` are removed; `status().tenant` names the Host's Tenant, and `deriveTenantKey` / `deriveStudioToken` derive its keys. Local Host resolution reads the stack's Host root (`stack` option, `NYLORUN_STACK`, or the Project link's `stack`); `NYLORUN_HOME` and `home` still override it. `stackHostRoot(name)` is exported.
  - **Breaking (`@nylorun/studio`): Studio serves its installation's Tenant.** The Tenant picker, list and create are gone, with `/_studio/tenants`; `/` opens `/tenants/<id>`. The `/tenants/:tenant` routes and the login token's `tenant` claim stay for embedders and must name that Tenant. The proxy sends no `Nylorun-Tenant`.
  - **`@nylorun/create-agent`:** the next steps are `npx nylorun start`, then `npm run dev`.
  - `@nylorun/core`: `ProjectLinkFileSchema` accepts format 2 with `stack`, and `tenantId` is optional; `ERROR_CODES` loses `tenant_conflict` and `active_work`.

### Minor Changes

- ee9e471: **Only the gateway can read the vault key (F4.2).** `nylorun start` writes the Tenant's vault key to `<Host root>/keys/vault-kek`. Only the `gateway` container mounts `keys/`, read-only, and runs `--service gates,keys`. The runtime container covers `keys/` and `docker/` with empty read-only mounts, so it reads neither the vault key nor Restate's private key and `.env`. `nylorun reset` deletes the key with the Tenant's data.
- e3af093: **A stack's Docker Compose files live in `docker/`.** `compose.yaml`, `.env` and `restate-identity.pem` are written to `~/.nylorun/stacks/<name>/docker/` (or `$NYLORUN_HOME/docker/`), so the folder says what it holds: to change a port, edit `docker/.env`. The single stack of older releases keeps its `~/.nylorun/stack/`, which `nylorun legacy` reads as it is.
- 7bd38d6: **The local stack runs a gateway container: model calls leave the Runtime.** `nylorun up` now runs the Runtime image twice, the combined packing: `runtime` (`--service core,loop`: the APIs and the agent loop) and `gateway` (`--service gates,keys`: the Model Gate, the Tool Gate and the keys service). Every model call, remote MCP call and Action delivery of the loop crosses the gateway, which alone reads the Tenant's credentials and the vault key. A new stack starts with the gateway.

  - **Breaking for hand-written Compose files:** in a container, a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`. Run the image a second time with `--service gates,keys` (see `DEPLOYMENT.md`). The image's default command is now `--service core,loop`.
  - The gateway has no published port, mounts only the Host's Tenant directory (`tenant/`) and `keys/`, both read-only, and reaches model servers on this machine at `host.docker.internal`. `docker/.env` holds `NYLORUN_GATES_TOKEN`, generated once and kept across starts.
  - `nylorun status` shows a Gateway line, `nylorun doctor` fails when the gateway is unhealthy and names `nylorun logs gateway`, and `nylorun logs gateway` is accepted.
  - An image set with `NYLORUN_RUNTIME_IMAGE` must be this release or newer: older Runtimes don't know `--service`.

- 31cfec0: **Action deliveries leave through the gateway (F4.1).** With the gates service, every delivery and endpoint ping is POSTed by the gateway (`POST /nylorun/v1/deliveries`) under the gateway's own `NYLORUN_ENDPOINT_*` policy. The delivery state machine is unchanged. A gateway that cannot be reached counts as a delivery that was not sent, so it is retried, and its failure code is `gateway.unreachable`.

  - `nylorun`: the `gateway` container now sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host`, so Action endpoints on this machine stay reachable.
  - A process that runs only `core` also reads `NYLORUN_GATES_URL`, for endpoint pings.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
  - @nylorun/core@0.10.0-beta

## 0.3.0-beta

### Minor Changes

- e28b8a9: **New projects serve their tools as an Action endpoint.** Everything Nylorun ships now uses Action endpoints instead of executors. `connectAgents` still works, but it is deprecated.

  - **Starter (`create-agent`).** `src/main.ts` serves the agents with `createActionHandler` on `http://localhost:3001/nylorun/actions` (`PORT`, `NYLORUN_ACTIONS_URL`) and registers it. `npm run dev` and `npm start` work as before. The README explains which URL the Runtime must reach.
  - **Local stack (`nylorun`).** The Runtime container sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host` and maps `host.docker.internal` to the Docker host, so a `localhost` endpoint on the developer's machine is reachable, on Linux Docker Engine too.
  - **Examples.** The AG-UI and browser-direct apps serve their Action endpoint at `/nylorun/actions` beside their other routes, and `register(origin)` replaces `connection.ready`.
  - **Docs.** The README, `DEPLOYMENT.md` and the `@nylorun/agents` README describe Action endpoints.

- 50d0fb5: **The Admin API on its own listener.** A Runtime can serve the Admin API on an operator listener, so the port that faces browsers and reverse proxies serves the Tenant API alone. The stack does this by default.

  - **Runtime.** With an operator listener (`adminPort` in `host.json`, or `NYLORUN_ADMIN_LISTEN_PORT`, `NYLORUN_ADMIN_LISTEN_HOST` and `NYLORUN_ADMIN_ALLOWED_HOSTS` in a container), the public listener answers `/v1/admin/**` with the opaque `404` and the operator listener serves the Admin API, Host shutdown and the Tenant API, never to browsers. Each checks `Host` against its own port. `/ready` needs both listening; a taken port on either exits with code 98. Without one, a single listener serves everything as before.
  - **Stack.** `nylorun start` publishes the operator port on loopback (`NYLORUN_ADMIN_PORT`, default 8788), writes it to `host.json` as `adminPort`, and points Studio at `runtime:4001`. `nylorun status` prints it.
  - **Admin client.** Reads `adminPort` from `host.json` and sends Admin API requests there (`admin.adminUrl`); `admin.url` stays the Tenant API URL. A `host.json` without `adminPort` keeps working.

- 9546ac7: **The stream relay, ready to wire in.** The Runtime gains the relay that will feed S2 from a Postgres record of session events over logical replication (Durable Streams v1); nothing uses it yet.

  - **Relay core** (`streams/relay/`): per-session pumps appending with `matchSeq`, acknowledgements only after S2 has the rows, refills from the record on a gap, reconciliation after a new or lost slot, and rows of an old basin generation dropped.
  - **Change source** (`adapters/replication/pgoutput.ts`): a persistent `pgoutput` slot, one active process per slot, always resumed from the confirmed position; a pending reconciliation is kept in `nylorun_streams.relay_slots` so a crash cannot skip it.
  - **Shared schema** (`nylorun_streams`): `session_events`, `session_log_heads`, `relay_slots` and the `nylorun_stream_relay` publication, migrated by the Host.
  - **Basin generations**: `basinOf(tenantId, generation)` names a Tenant's later basins (`<basin>-<g base36>`).
  - **Local stack**: Postgres runs with `wal_level=logical` and `max_slot_wal_keep_size=4GB`. `nylorun start` recreates the Postgres container once; its data volume is kept. `DEPLOYMENT.md` lists the settings for a Postgres you run yourself.

- 9d52189: **Embedding Studio in a desktop app.** Studio can be shown inside a desktop app such as Babai Desktop, in an iframe loaded from its URL and signed in by `postMessage` with a token limited to one Tenant.

  - **`nylorun`.** The local stack lets Babai's origins frame Studio: `NYLORUN_STUDIO_FRAME_ANCESTORS` in `stack/.env` defaults to `nylorun://localhost http://nylorun.localhost` and is passed to the Studio container. `nylorun start --studio-embed-origin <origin>` (repeatable) adds an exact origin, such as a desktop app's dev server, and keeps it across starts until `--studio-embed-origin-reset`. Wildcards are refused. `nylorun status` lists the origins under `Embeds`, and `status --json` as `studio.embedOrigins`.
  - **`@nylorun/admin`.** `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` mints a single-use Studio login token from an app's backend. With `tenant`, the session it leads to reaches only that Tenant.
  - **Studio.** `POST /_studio/sessions` exchanges such a token for a one-hour bearer session kept in the frame's memory; dashboard pages send `frame-ancestors` from the allowlist instead of `X-Frame-Options: DENY`; `?embed=1` hides Studio's branding, follows the app's theme and routes, and reports its own; `/tenants/:tenant/sessions/:session` opens a session by id. The cookie login of `nylorun studio` is unchanged.

    The dashboard routes `/tenants/:tenant`, `/tenants/:tenant/agents/:agent`, `/tenants/:tenant/agents/:agent/sessions/:session`, `/tenants/:tenant/sessions/:session`, `/tenants/:tenant/vault` and `/tenants/:tenant/settings` are now a public contract for embedders: removing or changing one is a breaking change.

### Patch Changes

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

- c0f4623: `nylorun up`/`start` refuses to downgrade the shared stack. When this release pins a Runtime older than `host.json` `runtimeVersion` or the running Runtime's `/health` version, it exits 5 before changing the stack files or containers, and names the remedy: update nylorun, or pass the new `--allow-downgrade` flag. `nylorun studio` applies the same check when it starts the stack. With `NYLORUN_RUNTIME_IMAGE` set, the check is skipped and `host.json` keeps its recorded `runtimeVersion`.
- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [c7614a4]
- Updated dependencies [679c488]
- Updated dependencies [c85cd9e]
- Updated dependencies [4282d5f]
- Updated dependencies [82d95ef]
- Updated dependencies [f48f12f]
- Updated dependencies [50d0fb5]
- Updated dependencies [50d0fb5]
- Updated dependencies [c121144]
- Updated dependencies [6ab4c59]
- Updated dependencies [6ab4c59]
- Updated dependencies [2ab8ed1]
- Updated dependencies [c121144]
- Updated dependencies [9546ac7]
- Updated dependencies [9546ac7]
- Updated dependencies [9d52189]
- Updated dependencies [50d0fb5]
- Updated dependencies [18468d9]
  - @nylorun/core@0.9.0-beta

## 0.2.1-beta

### Patch Changes

- db956bc: Studio creates Tenants. While the Host has none, Studio asks for a name and creates the first one. A Tenant with no agents shows **Connect your code**: its model provider, the `npx @nylorun/cli tenant use <id>` command, and `npm run dev`. It switches to the agent list when the first agent registers.

  Every Tenant Studio creates registers the derived principal `project` (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). `nylo tenant use` now falls back to that key, derived from the local admin key, so a Project links a Studio-created Tenant with no stored key. When it replaces a one-time application key, it keeps that key as `.nylorun/credentials.<tenantId>.json`, and `nylo tenant use <that id>` switches back. `nylorun up` again offers Studio for creating the first Tenant.

- Pin studio to the tested release.

## 0.2.0-beta

### Minor Changes

- c82aa6f: `nylorun up` prints Studio as `http://localhost:<port>`, with no login token in it, and in a terminal opens Studio in the browser already signed in (`--no-open` keeps the browser closed). The Studio sign-in lasts 30 days and survives Studio restarts: the session cookie is signed with a key derived from the admin key instead of being held in memory. `nylorun studio` prints the plain URL when it opens the browser; `nylorun studio --no-open` still prints the single-use login URL.

### Patch Changes

- 5e4947a: `nylorun up` no longer says a Tenant can be created in Studio, which has no way to create one. While the Host has no Tenant, it names `npx @nylorun/cli tenant create` alone.
- Pin studio to the tested release.

## 0.1.2-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.1.1-beta

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.1.0-beta

### Minor Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

### Patch Changes

- Pin core to the tested release.
- Pin runtime to the tested release.
- Pin studio to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta
