# Public API requirements for Studio resource browsing

Studio uses only the public Runtime and Management APIs through its authenticated
same-origin proxy. This change adds no database connection, storage client,
Runtime route or SDK method. Artifacts are read-only except a message's attachments,
uploaded into its session (protocol 12); Environments
(protocol 11) are created, relabelled, forked, stopped, reset and deleted, their manifests
saved (protocol 14), and their disk versions kept, restored, forked and deleted, through their
public routes. An Environment never changes what it runs: a new manifest version reaches it
through a fork.

## Artifact pages

The Tenant-wide Artifacts table uses the opt-in pages of `GET /v1/artifacts`
(`artifacts.page()`, Host feature `artifact-reads`): `limit=50`, the opaque
`nextCursor`, and the `sessionId`, `kind` and `label` filters. Studio checks the
feature on `/health` first; without it, the page offers a session lookup and
opening by ID, and never fetches the unbounded legacy list. An artifact view's
`environmentId` names the Environment whose disk versions it holds, so the table
and inspector link it to that Environment.

## Existing APIs used now

| Studio view | Public API / SDK |
| --- | --- |
| Environment table, sidebar groups, manifest and label filters | `environments.list()` → `GET /v1/environments` and `environments.manifests.list()` → `GET /v1/environment-manifests`, grouped and filtered in the browser as sessions are |
| Environment metadata and manifest | `environments.get()` → `GET /v1/environments/{id}` |
| New Environment, from inline fields or a manifest version | `environments.put(id, fields)` or `environments.put(id, { manifest: "name@n" })` → `PUT /v1/environments/{id}` |
| Edit labels and owner | `environments.put(id, …)` → `PUT /v1/environments/{id}` (what it runs is unchanged) |
| Fork: a new Environment from a manifest version, with this one's disk and secrets | `environments.planFork()`, `.fork()` → `POST /v1/environments/{id}/fork` (`dryRun: true` for the plan) |
| Environment manifests | `environments.manifests.list()`, `.get()`, `.plan()`, `.save()` → `GET /v1/environment-manifests`, `GET` and `PUT /v1/environment-manifests/{name}` (`?dryRun=true` for the plan, `If-Match` the version read) |
| Stop, Reset (pods), Delete | `environments.stop()`, `.reset()`, `.delete()` → `POST /v1/environments/{id}/stop`, `POST …/reset`, `DELETE /v1/environments/{id}` |
| Secrets tab (names, types, bindings) | `environments.secrets.list()` → `GET /v1/environments/{id}/secrets` |
| Secrets tab forms | `environments.secrets.put()`, `.delete()` → `PUT`, `DELETE /v1/environments/{id}/secrets/{name}` |
| Disk tab: versions | `environments.versions()` → `GET /v1/environments/{id}/versions` |
| Disk tab: Snapshot disk, Restore, Delete | `environments.snapshot()`, `.restore(id, version)`, `.deleteVersion()` → `POST …/snapshot`, `POST …/restore`, `DELETE …/versions/{n}` |
| Disk tab: New Environment from a version | `environments.put(id, { …fields, from: { environment, version } })` → `PUT /v1/environments/{id}` |
| Disk tab: Browse a version | the artifact reads below, on the `artifactId` the versions read names |
| Setup & files tab | the manifest's `setup` and `files` from `GET /v1/environments/{id}`, read only |
| Session's Environment tab | `session.inspect()` (`environment: { id, version }`), `environments.get()`, Management `coverage({ agentId, environmentId })` |
| Sessions that name it | `sessions.page({ environmentId })` → `GET /v1/sessions?limit=50&environmentId=…` |
| Lifecycle events, manual refresh | `environments.events({ from })` → `GET /v1/environments/{id}/events?from=…` |
| New session's Environment picker | `environments.list()` → `GET /v1/environments`; Management `coverage({ agentId, environmentId })` → `POST /v1/tenant/credential-coverage` |
| Preview tools | Management `mcp.preview({ url, environmentId })` → `POST /v1/tenant/mcp/preview` |
| Tenant artifacts table | `artifacts.page({ kind, sessionId, labels, cursor })` → `GET /v1/artifacts?limit=50&…` |
| Session artifact list | `artifacts.list({ sessionId })` → `GET /v1/artifacts?sessionId=…` |
| Artifact metadata and versions | `artifacts.get()` → `GET /v1/artifacts/{id}` |
| Pinned file preview | `artifacts.download({ version, range })` → version `content` |
| Exported folder files and changes | `artifacts.tree()`, `.file()`, `.diff()` → version `tree`, `files/{encodedPath}`, `diff` |
| Native streamed download | `artifacts.link({ version, file?, expiresIn: 60 })` → authenticated `POST /v1/artifacts/{id}/links`, then public `GET /v1/artifact-links/{token}` |
| Message attachments | `artifacts.upload(file, { name, sessionId, contentType })` → `POST /v1/artifacts?name=…&sessionId=…` (the proxy keeps only those two, checks `GET /v1/sessions/{id}`, needs `Content-Length`, refuses over `maxUploadBytes`, 32 MiB, and streams the body); then `session.inputParts([text?, …{ type: "file", artifactId, version }])` → `POST /v1/sessions/{id}/commands`; any file is accepted (protocol 15) |
| Model inputs (Model settings) | Management `models.catalog()` → `GET /v1/tenant/models` (each model's `inputs` and `addableInputs`); `models.setInputs({ provider, model, inputs })` → `PUT /v1/tenant/models/inputs` (allowed by the proxy); a custom endpoint's `models.put({ settings: { inputs } })` |

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
