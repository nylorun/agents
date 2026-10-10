# Public API requirements for Studio resource browsing

Studio uses only the public Runtime and Management APIs through its authenticated
same-origin proxy. This change adds no database connection, storage client,
Runtime route or SDK method. Sandboxes and artifacts are read-only in this increment.

## Required parallel PR: artifact pagination

`GET /v1/artifacts` currently returns the entire reachable collection. Studio
calls it **only with a session ID**. The tenant-wide Artifacts view offers a
session filter and lookup by artifact ID; it does not fetch the entire Tenant,
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
| Sandbox table and labels | `sandboxes.page()` → `GET /v1/sandboxes?limit=50&label=…&cursor=…` |
| Sandbox metadata | `sandboxes.get()` → `GET /v1/sandboxes/{id}` |
| Attached sessions | `sessions.page({ sandboxId })` → `GET /v1/sessions?limit=50&sandboxId=…` |
| Lifecycle events, manual refresh | `sandboxes.events({ from })` → `GET /v1/sandboxes/{id}/events?from=…` |
| Session artifact list | `artifacts.list({ sessionId })` → `GET /v1/artifacts?sessionId=…` |
| Artifact metadata and versions | `artifacts.get()` → `GET /v1/artifacts/{id}` |
| Pinned file preview | `artifacts.download({ version, range })` → version `content` |
| Exported folder files and changes | `artifacts.tree()`, `.file()`, `.diff()` → version `tree`, `files/{encodedPath}`, `diff` |
| Native streamed download | `artifacts.link({ version, file?, expiresIn: 60 })` → authenticated `POST /v1/artifacts/{id}/links`, then public `GET /v1/artifact-links/{token}` |

All version reads and download links name an explicit numbered version. Sandbox
IDs and folder file paths remain single encoded path segments. Studio holds the
installation key on the server. The Runtime capability is the credential for a
native download, including in an embed; metadata and link minting still require
Studio authentication. Tokens expire after 60 seconds and are never logged by
Studio or put in application navigation state.

## Later work

Sandbox event reads currently return all events from a sequence. Studio reads
on opening Events and on explicit Refresh, accumulates by sequence, and never
polls or attaches a sandbox SSE stream. Bounded event pages would improve large
histories, but are not a blocker for this increment.

Artifact version histories and folder trees are also ordinary existing reads.
Their pagination, lifecycle controls, uploads, deletion, share UI, workspace
browsing and snapshots are deferred. Do not introduce Studio-only data endpoints
or direct infrastructure access to fill these gaps.
