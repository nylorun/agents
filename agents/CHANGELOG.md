# @nylorun/agents

## 0.15.0-beta

### Major Changes

- 98b0d37: **Protocol 8: the Runtime API and the Management API take separate keys (Runtime and Management APIs, step A4).** Upgrade every package together; `nylorun`, `@nylorun/cli` and Studio already use management keys (A3).

  - **Breaking (`@nylorun/runtime`): `/v1/tenant/*` takes only a management key.** An application key there, alone or acting for a subject, is `403 key_role_mismatch`; a management key acting for a subject is `403 subject_invalid`. This covers the Tenant's status, seed and reset, models, providers, usage and budgets, sandbox and artifact settings, application keys, vaults and signing keys. A management key on any other route but `/v1/me` and the public `/v1/access/jwks` is `403 key_role_mismatch`.
  - **Breaking (`@nylorun/runtime`): vaults and signing keys moved.** They are at `/v1/tenant/vaults…` (including `…/oauth/start`) and `/v1/tenant/signing-keys…`; `/v1/vaults…` and `/v1/access/signing-keys…` are gone, with no alias. Opening a session with `vaultIds` is unchanged, as are `GET /v1/oauth/callback` and `GET /v1/access/jwks`.
  - **Breaking (`@nylorun/core`, `@nylorun/runtime`): `tenant:settings` is retired.** It leaves `SUBJECT_SCOPES`; `Nylorun-Scopes` may still name it and it grants nothing. `/v1/tenant/models` and `/v1/tenant/providers` no longer admit `agents:write` subjects: apps don't read the model catalog.
  - **Breaking (`@nylorun/agents`):** the vault methods (`createVault`, `listVaults`, `getVault`, `deleteVault`, `createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`) and `client.access.signingKeys` / `SigningKeysClient` are removed; use `admin.vaults` and `admin.signingKeys` from `@nylorun/admin`'s `createManagementClient`. `client.access.jwks()` stays.
  - `@nylorun/core`: `PROTOCOL_VERSION` is 8 and `HOST_PROTOCOL` 4–8, with the required feature `management-api`. Runtime API routes keep their request and response shapes.
  - `@nylorun/runtime`: `startEphemeralRuntime` registers a management key (`managementKey`, the key `bootstrap`).

### Patch Changes

- b28bdd7: **Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

  - `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
  - `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
  - `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
  - `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.

- Pin core to the tested release.
- Updated dependencies [3b3bdc6]
- Updated dependencies [6576e12]
- Updated dependencies [b28bdd7]
- Updated dependencies [cc107b1]
- Updated dependencies [7f763c3]
- Updated dependencies [98b0d37]
  - @nylorun/core@0.14.0-beta

## 0.14.0-beta

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

- Pin core to the tested release.
- Updated dependencies [8773586]
- Updated dependencies [e1bfb4b]
- Updated dependencies [5cfaed9]
- Updated dependencies [bd478ee]
- Updated dependencies [c0b604e]
  - @nylorun/core@0.13.0-beta

## 0.13.0-beta

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

- 926711b: **Sandboxes are a resource (F7.1, blueprint D39; Host feature `sandboxes`).** A sandbox has its own id, a kind, a spec and labels, and outlives the sessions attached to it. Additive: protocol 5 is unchanged.

  - `PUT /v1/sandboxes/{id}` creates a sandbox or finds the one with that id (get-or-create in one call); `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=key=value` (repeatable), `GET /v1/sandboxes/{id}/events` and `DELETE /v1/sandboxes/{id}`. Ids are `/`-separated segments (`team-a/proj-42`), sent percent-encoded as one path segment. Only kind `virtual` runs; `pod` is refused with `sandbox_unavailable`. The spec is resolved against the Tenant's limits and fixed once the sandbox exists; labels can change.
  - A session attaches with `sandbox: { id }` and shares the sandbox's `/workspace` with every other session attached to it. Turns are serial per sandbox: a second session's turn is refused with `409 sandbox_busy` while another runs. Deleting a session (a sessions reset) only detaches it. Deleting a sandbox is refused while a turn runs in it; afterwards an attached session's next turn is refused with `sandbox_unavailable` until a sandbox with that id exists again.
  - Subject tokens carry an `sbx` claim: `POST /v1/tokens` takes `sandboxes`, exact ids or prefixes ending in `/*` (at most 16). A token reaches only the sandboxes they match, checked when a session attaches and at every turn start (`403 sandbox_not_granted`); any other sandbox is the 404 of a missing one. The new scope `sandboxes:write` lets a role create and delete the sandboxes its grants reach. Application keys reach every sandbox.
  - The Tenant holds at most `limits.sandboxes` sandboxes (`PUT /v1/tenant/sandbox`, default 100); one more is `409 limit_exceeded`.
  - Lifecycle events (`sandbox.created`, `sandbox.attached`, `sandbox.detached`, `sandbox.deleted`) go to the sandbox's own stream in the record, through the record module; the session's log records `sandbox.attached`. The sandbox stream is not relayed to S2.
  - New error codes `sandbox_not_granted`, `sandbox_busy` and `sandbox_unavailable`; the session view gains `sandboxId` and `sandboxSource: "sandbox"`. Migration `0004_sandbox_resources` adds `sandbox_resources`, `nylorun_streams.sandbox_events` and the sessions' `sandbox_id` column.
  - `@nylorun/agents`: `client.sandboxes` with `ensure(id, spec)`, `get`, `list({ labels })`, `delete`, `events`, and `forSession({ session, spec })`, which creates a sandbox for one session, opens the session on it, and deletes it with `release()`. It replaces sharing through another session (`sandbox: { session }` and the view's `sandboxOwnerId`, now deprecated). `client.tokens.create` takes `sandboxes`.
  - `nylorun sandbox ls [--label key=value]... [--json]` and `nylorun sandbox rm <id>` list and delete the running local Tenant's sandboxes.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [b352feb]
- Updated dependencies [6077272]
- Updated dependencies [b6bf1f5]
- Updated dependencies [8ed4ea6]
- Updated dependencies [678e085]
- Updated dependencies [926711b]
  - @nylorun/core@0.12.0-beta

## 0.12.0-beta

### Minor Changes

- 4b9906f: **Breaking: "Tenant" replaces "stack", and `nylorun start` works anywhere.** Each local installation holds one Tenant, and its name is the Tenant's name, so help, output, errors and docs say Tenant. See MIGRATION.md.

  - **Breaking (`nylorun`): selection.** Every command acts on the Tenant `--tenant <name>` names (replaces `--name`, which is removed), else `NYLORUN_TENANT` (replaces `NYLORUN_STACK`), else the Project link's `tenant`; `start` in a project names a new one after the project directory. Outside a project, or with `start --no-link`, commands act on the Tenant `default`. In a project without a link, commands other than `start` exit 2 and list the machine's Tenants. A name starting with `tn_` (a Tenant id) is refused.
  - **Breaking (`nylorun`): files.** Host roots are under `~/.nylorun/tenants/<name>/` (was `~/.nylorun/stacks/<name>/`) with `tenant.json` (was `stack.json`); the `.env` key is `NYLORUN_TENANT_NAME` (was `NYLORUN_STACK_NAME`); `NYLORUN_COMPOSE_PROJECT` replaces `NYLORUN_STACK_PROJECT`. Compose projects stay `nylorun-<name>`. Every command first moves 0.4 Host roots from `~/.nylorun/stacks/` to `~/.nylorun/tenants/` (renaming `stack.json` and the `.env` key), so they keep their volumes and keys. `nylorun ls` lists only directories with `tenant.json`.
  - **Breaking (`nylorun`): removed.** `nylorun legacy` and all handling of the single stack of releases before 0.4; the hidden `nylorun stack <cmd>` alias; `nylorun doctor stack|runtime`. Output says Tenant: `ls` prints `TENANT` and JSON `{ "tenants": [...] }`, `status` prints the Tenant id on its own line, and `doctor`'s row is `tenant`.
  - **Breaking: Project link format 3.** `.nylorun/link.json` is `{ "format": 3, "tenant", "tenantId", "hostUrl", "hostId" }`; `tenant` replaces `stack`. `@nylorun/agents`, `@nylorun/cli` and `@nylorun/admin` refuse an older link and name `npx nylorun start`, which rewrites it. `@nylorun/core`'s `ProjectLinkFileSchema` parses formats 0–3 with `tenant`.
  - **Breaking (`@nylorun/admin`):** `createAdmin({ tenant })` replaces `{ stack }`, `tenantHostRoot(name)` replaces `stackHostRoot(name)`, and local resolution reads `NYLORUN_TENANT` and the link's `tenant`.
  - `@nylorun/cli`: `status` and `endpoints` drop the `stack` line and JSON key; messages say Tenant. `@nylorun/agents`: a Runtime too old for the client says "update the Runtime (npx nylorun@latest start)". `@nylorun/studio`: setup hints say Tenant. `@nylorun/create-agent`: the next steps describe `npx nylorun@beta start` as this project's Tenant and its link.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [4b9906f]
  - @nylorun/core@0.11.0-beta

## 0.11.0-beta

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

- Pin core to the tested release.
- Updated dependencies [fed780d]
- Updated dependencies [fed780d]
- Updated dependencies [7f4c3f1]
- Updated dependencies [5ca1923]
- Updated dependencies [5ca1923]
  - @nylorun/core@0.10.0-beta

## 0.10.0-beta

### Major Changes

- c121144: **Definitions no longer declare a sandbox.** `.sandbox()` on ReAct and flow agents, and the `sandbox`, `SandboxError`, `SandboxOptions` and `SandboxCapability` exports, are removed. Open the session with one instead, `createSession({ sandbox: { … } })`, or set the Tenant's default; see `MIGRATION.md`.

  - **Build and registration.** A capability that still carries `sandbox` fails the build (`sandbox.in-definition`), and `PUT /v1/agents/:id` refuses such a definition with a `400` that names it. Definitions stored before this release keep their sandbox.
  - **Trees.** `sandbox.mismatch` and `workflow.sandbox-mismatch` are gone, with the workflow manifest's derived `sandbox`: a tree shares the sandbox its session was opened with.
  - **Executors.** The action claim reports whether the session has a sandbox (`ActionClaim.sandbox`), and `ctx.sandbox` follows it.

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

- 5f23047: **Action endpoints: `createActionHandler` (preview; needs a Runtime with the `action-endpoints` feature to register).** An application serves its agents' tools, hooks and workflow functions from one HTTP handler, which the Runtime will call, in place of `connectAgents`.

  - `createActionHandler({ agents })` returns `{ fetch, node, register }`. `fetch` is a web-standard handler and `node` serves `node:http` and Express. Each request is verified before any code runs: its delivery token (`Nylorun-Signature`) must be an ES256 token signed by the Tenant's signing key, for this Tenant, this URL, this Action and generation, and the exact body. The Action then runs through the same code executors use, with the request's signal as `ctx.signal`. The answer is the tagged outcome (`Nylorun-Outcome: 1`). An agent or tool it does not serve answers `404`, and a workflow Action for another version of the workflow answers `409`. A token signed with a key the handler has not seen yet (just after a rotation) answers `503`, which the Runtime retries.
  - A process that only serves Actions needs no key: set `runtime: { url, tenant }` and it reads the Tenant's public keys, or pass them in `jwks`. Verification uses WebCrypto; the SDK takes no JWT dependency.
  - `register({ url })` saves the definitions (`saveDefinitions: false` skips it), registers the URL for every served agent, and pings each one through the Runtime. It refuses a Runtime without `action-endpoints` before sending anything.
  - `ctx.sandbox` calls back with the delivery token. `createActionSandbox` accepts no claim for this case, and `Transport.withKey` copies a transport with another bearer, sharing its compatibility check.

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

- e28b8a9: **New projects serve their tools as an Action endpoint.** Everything Nylorun ships now uses Action endpoints instead of executors. `connectAgents` still works, but it is deprecated.

  - **Starter (`create-agent`).** `src/main.ts` serves the agents with `createActionHandler` on `http://localhost:3001/nylorun/actions` (`PORT`, `NYLORUN_ACTIONS_URL`) and registers it. `npm run dev` and `npm start` work as before. The README explains which URL the Runtime must reach.
  - **Local stack (`nylorun`).** The Runtime container sets `NYLORUN_ENDPOINT_LOOPBACK=docker-host` and maps `host.docker.internal` to the Docker host, so a `localhost` endpoint on the developer's machine is reachable, on Linux Docker Engine too.
  - **Examples.** The AG-UI and browser-direct apps serve their Action endpoint at `/nylorun/actions` beside their other routes, and `register(origin)` replaces `connection.ready`.
  - **Docs.** The README, `DEPLOYMENT.md` and the `@nylorun/agents` README describe Action endpoints.

- 50d0fb5: **AG-UI in the Runtime.** The Runtime serves AG-UI itself at `/v1/ag-ui/agents/:agent` (optional Host feature `ag-ui-endpoint`), and pages reach it directly with a subject token. `@nylorun/agents` no longer contains or depends on any AG-UI package.

  - **Runtime.** `POST /v1/ag-ui/agents/:agent` runs (a `RunAgentInput` in, server-sent AG-UI events out); `GET …/threads/:thread/messages`, `GET …/threads/:thread/events` (reattach) and `POST …/threads/:thread/cancel`. For a person named by a subject token (limited to the role's agents) or by subject headers; an application key alone is `400`. A thread's session (`sessionIdFor`, unchanged, so existing threads keep their sessions) is created on its first run with `forwardedProps.nylorun.session` (`vaultIds`, `credentialSelections`, and `info` from app servers only) and never changed afterwards. Limits and a busy session are streamed as `RUN_ERROR`. A stream opened with a token ends at the token's expiry or revocation with `CUSTOM nylorun.stream_closed`. The translation moves here from `@nylorun/agents`, and `@ag-ui/core` becomes a Runtime dependency.
  - **Agents SDK.** `createAgUiHandler` keeps its options and routes and forwards each request to the Runtime acting for the signed-in person; it now needs a Runtime with `ag-ui-endpoint` (`502 runtime_feature_missing` otherwise). `session()` options apply when a thread's session is created; whatever the browser sends in `forwardedProps.nylorun` is replaced. `@ag-ui/core` is no longer a dependency. `@nylorun/agents/browser` adds `agUi(agentId)`, a `{ url, fetch }` for `HttpAgent` that adds the key and a current token and reattaches a run the Runtime ended at token expiry, so the agent sees one run, and `agUiHistory()`. The transport gains `forward()`, which returns the Runtime's response as it is.

- 50d0fb5: **Browser access: web pages and apps call the Runtime with a publishable key.** A page ships a publishable key and gets subject tokens from its app server; the Runtime answers it directly, with CORS (optional Host feature `browser-access`).

  - **Publishable keys.** `nr_pub_<tenantId>_…`, sent in `Nylorun-Key`, name the Tenant and one app, with an origin allowlist (exact origins, or `http://localhost:*` and `http://127.0.0.1:*` for development; none for native apps). `GET`/`POST /v1/access/publishable-keys`, `PUT`/`DELETE …/:id`. A key alone grants the policy's `anon` role, at most the public agent list, and reaches no session or vault. Postgres migration 4.
  - **Host.** With browser access on, requests with an `Origin` reach Tenant routes; `/health`, `/ready` and admin routes still refuse them. Preflights for browser routes (agents, sessions, vaults, AG-UI, JWKS) are answered from the route alone and grant no credentials; the actual request must carry a publishable key whose allowlist names the origin, and only then do responses (JSON, errors, `401`, `429`, event streams) carry CORS headers. A disallowed origin or unknown key gets the opaque `404`. Tenant and executor keys sent with an `Origin` are refused before they are looked up. `Nylorun-Tenant` may be left out when `Nylorun-Key` names the Tenant; both must agree when both are sent. Browser access is on in the stack (`NYLORUN_BROWSER_ACCESS=off` turns it off) and off for a Host started from `host.json` unless `browserAccess` is true.
  - **JWKS.** `GET /v1/access/jwks` is readable by any caller that reaches the Tenant.
  - **Agents SDK.** `@nylorun/agents/browser`: `createBrowserClient({ url, publishableKey, token })` keeps subject tokens in memory, refreshes them a minute before expiry or after `401 token_expired`, one fetch at a time, and creates sessions and vaults owned by the token's subject; it loads no Node module. `createTokenEndpoint()` is the app server's token route. `client.access.publishableKeys` manages keys. The transport accepts a `token` source and a `publishableKey`, and event streams the Runtime ends at token expiry reconnect at once. The Tenant API client classes move to a module with no Node imports; `@nylorun/agents` and `/client` export the same names.
  - **CLI.** `nylo access keys list|create|set-origins|revoke`.

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

- Pin core to the tested release.
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

## 0.9.0-beta

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

- Pin core to the tested release.
- Updated dependencies [e537a82]
- Updated dependencies [5278b4e]
- Updated dependencies [426fd27]
- Updated dependencies [8cda500]
  - @nylorun/core@0.8.0-beta

## 0.8.0-beta

### Minor Changes

- a322696: **`@nylorun/agents/ag-ui`: serve agents to AG-UI clients from your own server.** `createAgUiHandler({ basePath, agents, subject })` returns a web-standard `fetch` handler (plus `run`, `history`, `reattach` and `cancel`), and `toNodeListener` adapts it to `node:http` and Express.

  - One session per person, agent and thread; the AG-UI message id is the idempotency key, so a retried run replays the same turn.
  - Approvals become AG-UI interrupts and resume through `runAgent({ resume })`.
  - History returns a plain AG-UI `Message[]` with the ids the live run used; reattach continues a run from `Last-Event-ID`.
  - Needs a Runtime with `transcript-events`. Adds the `@ag-ui/core` dependency (`~1.0.0`), loaded only by this subpath.

  `AgentsClient.hostFeatures()` returns the Runtime's protocol features, including optional ones.

- 844bff3: **Act for a person: `Nylorun-Subject` and `Nylorun-Scopes`.** An app server that holds the Tenant key can name the person each request is for, and the Runtime enforces it (optional Host feature `subject-headers`).

  - `client.as(subject, { scopes })` in `@nylorun/agents` sends both headers on every call, event streams included. Scopes: `agents:read`, `agents:write`, `sessions:own`, `vaults:own`, `tenant:settings`; default `["sessions:own"]`.
  - The Runtime limits a subject to the routes its scopes allow (`403 scope_required`) and to its own sessions and vaults: another owner's session, vault or sandbox is the same `404` as a missing one, including `PUT` on its session id (was `409`). Reset, config seed, executors, actions and the sandbox tool routes are open to no subject. Only application keys may send the headers.
  - The AG-UI handler calls the Runtime as each person and requires `subject-headers`; new optional `scopes` option. The host's `session()` parameters can no longer replace a session's id, agent or owner.
  - Core exports `SUBJECT_HEADER`, `SCOPES_HEADER`, `SUBJECT_SCOPES` and `parseSubjectHeaders`. Postgres Tenant schemas migrate to version 2 (an indexed session owner column).

  Requests without `Nylorun-Subject` are unchanged.

### Patch Changes

- 42272f8: The AG-UI handler answers `400` (`invalid_request`) when the Runtime refuses what the client sent, such as a `Last-Event-ID` it cannot read, instead of `502`.
- Pin core to the tested release.
- Updated dependencies [a322696]
- Updated dependencies [844bff3]
- Updated dependencies [a322696]
  - @nylorun/core@0.7.0-beta

## 0.7.0-beta

### Minor Changes

- bf1c2da: **Tenants can register a Studio principal.** `CreateTenantRequest` gains optional `studioCredentialHash` behind the new protocol feature `studio-principal`; the Runtime stores it as application principal `studio`, and idempotent create compares it too. `@nylorun/admin` exports `deriveStudioToken(adminKey, tenantId)` (HMAC-SHA256 over `nylorun/studio/v1`, NUL, Tenant id) and `createTenant` sends the hash of that key, so Studio can reach any Tenant's API with a key derived from the admin key. Clients require the new feature, so upgrade the Runtime with them.

### Patch Changes

- ba1b239: **`nylorun` sets up the local stack; `@nylorun/cli` becomes the Runtime client `nylo` (breaking beta).**

  - New unscoped package **`nylorun`**: `npx nylorun up` sets up the Docker stack on the first run and starts it after that, from any directory; `npx nylorun down` stops it (volumes are kept). `up` and `down` are aliases of `start` and `stop`. It also owns `status`, `logs`, `studio`, `reset` and `doctor`, pins the Runtime and Studio images (`package.json` `nylorun.runtime` / `nylorun.studio`), depends on `@nylorun/core` only, and never creates Tenants.
  - **`@nylorun/cli`** is the Runtime client with the command **`nylo`**: `nylo tenant create [name]` (creates the Tenant; in a project, writes the Project link and seeds the model provider and sandbox from `.env`), `nylo tenant current|list|use|status|reset|delete`, `nylo configure`, `nylo env` (was `nylorun status --env`) and `nylo doctor sandbox`. It no longer provides the `nylorun` command or the stack commands.
  - **Removed:** `nylorun dev` and `nylorun dev --ephemeral`. Link once with `nylo tenant create`, then run the project's own `npm run dev`. Moved commands exit 2 and name their replacement.
  - **Starter:** the generated project depends on `@nylorun/agents` only (no Nylorun devDependency); `dev` is `tsx watch --env-file-if-exists=.env src/main.ts`. `npm create @nylorun/agent` installs the project and prints the next steps (`npx nylorun up`, `npx @nylorun/cli tenant create`, `npm run dev`) instead of starting development; `--no-open` is accepted and ignored.
  - `connectAgents` names those steps when it finds no Runtime connection. Runtime repair hints, model errors and core's sandbox message name `nylo` and `nylorun up`.

- bf1c2da: **The microsandbox backend is removed; the Runtime runs sandbox tools on the virtual backend only.** The optional `microsandbox` dependency is gone. `sandbox.backend` and `NYLORUN_SANDBOX` accept `auto` or `virtual`, and `auto` selects `virtual`. A Tenant that stored `microsandbox` reads it as `auto`. `nylorun doctor sandbox` and the `nylorun dev` banner report only the virtual shell.
- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.6.0-beta

### Minor Changes

- c49efed: **Breaking (pre-1.0 minor):** Tenant API connection and executor credentials for Runtime Clients.

  - `resolveConnection()` — options → environment → Project link; sources never mix.
  - `createClient()` with no arguments uses `resolveConnection`.
  - `connectAgents` application mode: save agents, `PUT /v1/executors` with **derived** tokens (HMAC of application key + Tenant + agent id), connect; tokens are not stored in Project credentials.
  - Re-exports `PROTOCOL_FEATURES`, `ERROR_CODES`, `compareVersions`.

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.5.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [1cd7dc7]
  - @nylorun/core@0.4.0-beta

## 0.4.0-beta

### Minor Changes

- b8d822a: Add `mcp(...)` to declare MCP servers as one capability for `Agent.use`, matching agent-plugins / manifest v3 `mcpServers` shape.
- b8d822a: Add `skills(path)` to load an agentskills.io catalog folder into `Agent.use` without duplicating `skills` and `skillRecords`. Parse `SKILL.md` frontmatter with `gray-matter`.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.
- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
  - @nylorun/core@0.3.0-beta

## 0.3.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3a88f51]
  - @nylorun/core@0.2.0-beta

## 0.2.0-beta

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [2898d02]
  - @nylorun/core@0.1.1-beta

## 0.1.0-beta.1

Initial session SDK and connected SSE executor.
