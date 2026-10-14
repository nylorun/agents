# Public API requirements for Studio resource browsing

Studio uses only the public Runtime and Management APIs through its authenticated
same-origin proxy. This change adds no database connection, storage client,
Runtime route or SDK method. Artifacts are read-only in this increment; Environments
(protocol 11) are created, changed, stopped, reset and deleted, and their disk versions
kept, restored, forked and deleted, through their public routes.

## Required parallel PR: artifact pagination

`GET /v1/artifacts` currently returns the entire reachable collection. Studio
calls it **only with a session ID**. The `/artifacts` page (no sidebar entry)
offers a session filter and lookup by artifact ID; it does not fetch the entire Tenant,
truncate an unbounded response, or simulate pagination in the browser.

Add opt-in pagination to that public route and expose it to all clients:

- Explicit `limit` activates `{ artifacts: ArtifactListItem[], nextCursor: string | null }`.
  Preserve the existing `{ artifacts: ArtifactView[] }` response without `limit`.
- SDK `artifacts.page()`: default 50 rows, limits 1–200. Reuse existing metadata
  summaries; omit version histories and bytes from list responses.
- Order by `(createdAt DESC, artifactId DESC)` with opaque keyset cursors bound
  to the Tenant, route and normalized filters. Reapply grants/ownership on every
  page, including after permissions change. Return ordinary public errors for
  malformed or mismatched cursors.
- Equality filters: `sessionId`, `kind`, and existing label syntax. Define
  `sessionId` semantics for tenant-owned artifacts explicitly. A future text
  search is optional, not required for this Studio increment.
- Keep OpenAPI and shared schemas aligned. Publish an `artifact-reads` feature
  once the route and SDK ship; Studio enables the tenant table only after
  feature discovery confirms it. No protocol bump is needed for opt-in paging.
- Verify equal timestamps, concurrent inserts, filter changes, denied rows,
  cursor rejection and legacy response compatibility through public interfaces.

Once available, Studio can add the tenant table and use the same paging for
session-scoped lists. This is the only API blocker for the browsing design.

## Existing APIs used now

| Studio view | Public API / SDK |
| --- | --- |
| Environment table and labels | `environments.page()` → `GET /v1/environments?limit=50&label=…&cursor=…` |
| Environment metadata and recipe | `environments.get()` → `GET /v1/environments/{id}` |
| New Environment, Edit recipe | `environments.put(id, recipe)` → `PUT /v1/environments/{id}` |
| Stop, Reset (pods), Delete | `environments.stop()`, `.reset()`, `.delete()` → `POST /v1/environments/{id}/stop`, `POST …/reset`, `DELETE /v1/environments/{id}` |
| Secrets tab (names, types, bindings) | `environments.secrets.list()` → `GET /v1/environments/{id}/secrets` |
| Secrets tab forms | `environments.secrets.put()`, `.delete()` → `PUT`, `DELETE /v1/environments/{id}/secrets/{name}` |
| Disk tab: versions | `environments.versions()` → `GET /v1/environments/{id}/versions` |
| Disk tab: Snapshot disk, Restore, Delete | `environments.snapshot()`, `.restore(id, version)`, `.deleteVersion()` → `POST …/snapshot`, `POST …/restore`, `DELETE …/versions/{n}` |
| Disk tab: New Environment from a version | `environments.put(id, { …recipe, from: { environment, version } })` → `PUT /v1/environments/{id}` |
| Disk tab: Browse a version | the artifact reads below, on the `artifactId` the versions read names |
| Setup & files tab | the recipe's `setup` and `files` from `GET /v1/environments/{id}`; edited with `PUT` |
| Session's Environment tab | `session.inspect()` (`environment: { id, version }`), `environments.get()`, Management `coverage({ agentId, environmentId })` |
| Sessions that name it | `sessions.page({ environmentId })` → `GET /v1/sessions?limit=50&environmentId=…` |
| Lifecycle events, manual refresh | `environments.events({ from })` → `GET /v1/environments/{id}/events?from=…` |
| New session's Environment picker | `environments.list()` → `GET /v1/environments`; Management `coverage({ agentId, environmentId })` → `POST /v1/tenant/credential-coverage` |
| Preview tools | Management `mcp.preview({ url, environmentId })` → `POST /v1/tenant/mcp/preview` |
| Session artifact list | `artifacts.list({ sessionId })` → `GET /v1/artifacts?sessionId=…` |
| Artifact metadata and versions | `artifacts.get()` → `GET /v1/artifacts/{id}` |
| Pinned file preview | `artifacts.download({ version, range })` → version `content` |
| Exported folder files and changes | `artifacts.tree()`, `.file()`, `.diff()` → version `tree`, `files/{encodedPath}`, `diff` |
| Native streamed download | `artifacts.link({ version, file?, expiresIn: 60 })` → authenticated `POST /v1/artifacts/{id}/links`, then public `GET /v1/artifact-links/{token}` |

All version reads and download links name an explicit numbered version. Environment
IDs (which may hold `/`), secret names and folder file paths remain single encoded
path segments. Studio holds the
installation key on the server. The Runtime capability is the credential for a
native download, including in an embed; metadata and link minting still require
Studio authentication. Tokens expire after 60 seconds and are never logged by
Studio or put in application navigation state.

## Later work

Environment event reads currently return all events from a sequence. Studio reads
on opening Events and on explicit Refresh, accumulates by sequence, and never
polls or attaches an Environment SSE stream. Bounded event pages would improve large
histories, but are not a blocker for this increment.

Artifact version histories and folder trees are also ordinary existing reads.
Their pagination, lifecycle controls, uploads, deletion, share UI and live
workspace browsing are deferred (a disk version is browsable once kept). Do not introduce Studio-only data endpoints
or direct infrastructure access to fill these gaps.
