# Public API requirements for Studio resource browsing

Studio uses only the public Runtime and Management APIs through its authenticated
same-origin proxy. This change adds no database connection, storage client,
Runtime route or SDK method. Artifacts are read-only except a message's attachments,
uploaded into its session (protocol 12). Agents (protocol 16) are made from a saved
agent manifest, relabelled, forked, stopped, reset and deleted, and their disk
versions kept, restored and deleted, through their public routes. An Agent moves
between versions of its manifest with `PUT` (and `POST .../restart`); a fork changes
its kind, harness or storage. Agent
manifests are read only in Studio; they are saved from their repository
(`nylorun apply`).

## Artifact pages

The Tenant-wide Artifacts table uses the opt-in pages of `GET /v1/artifacts`
(`artifacts.page()`, Host feature `artifact-reads`): `limit=50`, the opaque
`nextCursor`, and the `sessionId`, `kind` and `label` filters. Studio checks the
feature on `/health` first; without it, the page offers a session lookup and
opening by ID, and never fetches the unbounded legacy list. An artifact view's
`agentId` names the Agent whose disk versions it holds, so the table and inspector
link it to that Agent.

## Existing APIs used now

| Studio view | Public API / SDK |
| --- | --- |
| Agents table, sidebar groups, state, manifest, owner and label filters | `agents.list()` → `GET /v1/agents` and `agentManifests.list()` → `GET /v1/agent-manifests`, filtered, sorted and grouped in the browser as sessions are |
| Agent page and its header | `agents.get()` → `GET /v1/agents/{id}`; `agentManifests.get(name, version)` → `GET /v1/agent-manifests/{name}/versions/{n}` for the version it runs (the Manifest tab and the Vault's uses); `agentManifests.get(name)` → `GET /v1/agent-manifests/{name}` for the latest version (**Move to v<n>**, **Fork to v<n>**) |
| New Agent, from a manifest it tracks or a version it pins | `agentManifests.versions(name)` → `GET /v1/agent-manifests/{name}/versions`; `agents.put(id, { manifest: "name" \| "name@n", owner?, labels? })` → `PUT /v1/agents/{id}` |
| Edit labels and owner | `agents.put(id, { manifest, labels, owner })` → `PUT /v1/agents/{id}` (its manifest as it was made: what it runs is unchanged) |
| Fork: a new Agent from a manifest version, with this one's disk and secrets | `agents.planFork()`, `.fork()` → `POST /v1/agents/{id}/fork` (`dryRun: true` for the plan) |
| Stop compute, Reset disk (pods), Delete Agent | `agents.stop()`, `.reset()`, `.delete()` → `POST /v1/agents/{id}/stop`, `POST …/reset`, `DELETE /v1/agents/{id}` |
| Sessions tab | the Agent view's `sessions`, with each one's times from the session list below |
| Triggers tab | `agents.triggers()` → `GET /v1/agents/{id}/triggers`; `agents.runs({ limit: 50 })` → `GET …/runs?limit=50`; each trigger's prompt from the manifest version |
| Triggers tab: Pause, Resume, Run now | `agents.pauseTrigger()`, `.resumeTrigger()` → `POST …/triggers/{id}/pause`, `…/resume` (`{}`); `agents.runTrigger()` → `POST …/triggers/{id}/run` (no body, an `Idempotency-Key` the proxy passes on) |
| Artifacts tab | `artifacts.list({ sessionId })` → `GET /v1/artifacts?sessionId=…` for each session on it, and the runtime's `files` |
| Memory tab | `agents.memories.list()` → `GET …/memories`; `.versions({ limit: 100 })` → `GET …/memory_versions?limit=100` for who changed each last |
| Memory tab: a memory, its history, Delete | `.get(path)` → `GET …/memories/{path}`; `.versions({ path })` → `GET …/memory_versions?path=…`; `.delete(path)` → `DELETE …/memories/{path}` |
| Vault tab (slots, types, bindings, set or not) | `agents.secrets.list()` → `GET /v1/agents/{id}/secrets`; the view's `slots` and `runtime.secrets`; the manifest version's harness for what uses each |
| Vault tab: Set value, Delete (a secret no slot declares) | `agents.secrets.put(id, name, { value } \| { headers })`, `.delete()` → `PUT`, `DELETE /v1/agents/{id}/secrets/{name}` |
| Disk tab: versions | `agents.versions()` → `GET /v1/agents/{id}/versions` |
| Disk tab: Snapshot now, Restore, Delete | `agents.snapshot()`, `.restore(id, version)`, `.deleteVersion()` → `POST …/snapshot`, `POST …/restore`, `DELETE …/versions/{n}` |
| Disk tab: Fork from a version | `agents.fork(id, { id, disk: n })` → `POST /v1/agents/{id}/fork` |
| Disk tab: Browse a version | the artifact reads below, on the `artifactId` the versions read names |
| Manifest tab | the version's manifest from `agentManifests.get(name, version)`; without it, the runtime, slots and limits from `GET /v1/agents/{id}`; read only. Its moves: `agents.put(id, { manifest: "name" \| "name@n" })`, `agents.restart(id, { retry? })` |
| Activity tab, refreshed by the header's Refresh | `agents.events({ from, types? })` → `GET /v1/agents/{id}/events?from=…` (`agent.*`; `types=agent.egress` for connections) |
| Agent manifests, a manifest's versions and one version's sections | `agentManifests.list()`, `.versions(name)`, `.get(name, version)` → `GET /v1/agent-manifests`, `GET …/{name}/versions`, `GET …/{name}/versions/{n}` |
| New session | `createSession({ id, agent, ownerUserId })` → `PUT /v1/sessions/{id}` (the proxy sets `ownerUserId: local-developer`) |
| Session's Manifest tab, Declared | `session.manifest()` → `GET /v1/sessions/{id}/manifest` (Host feature `session-reads`; without it, `agents.get()` and `agentManifests.get(name, version)`); `agentManifests.get(name)` for the latest version |
| Session's Manifest tab, Deployed | `session.inspect()` (`agentId`, `manifest: { name, version }`), `agents.get()`, Management `coverage({ agentId })`, `agents.events({ types: ["agent.egress"] })` |
| Session list with last activity | `sessions.page({ limit: 200, cursor })` → `GET /v1/sessions?limit=200&cursor=…`, every page, for each session's `createdAt` and `lastEventAt` (Host feature `session-reads`); without it `listSessions()` → `GET /v1/sessions`, with no times |
| Session's Usage tab | `session.usage()` → `GET /v1/sessions/{id}/usage` (tokens and `costSplit` by kind, `modelTimeMs`) and `session.modelCalls({ limit: 50, cursor })` → `GET /v1/sessions/{id}/calls/model?limit=50&cursor=…` (each call's timing and `usage.costSplit`), grouped by `turnId` (Host feature `session-reads`; both allowed by the proxy, read only). A call's View event finds its `message.assistant`, `model.failed` or `context.compacted` event by `payload.effectId` among the session's loaded events |
| Tenant artifacts table | `artifacts.page({ kind, sessionId, labels, cursor })` → `GET /v1/artifacts?limit=50&…` |
| Session artifact list | `artifacts.list({ sessionId })` → `GET /v1/artifacts?sessionId=…` |
| Artifact metadata and versions | `artifacts.get()` → `GET /v1/artifacts/{id}` |
| Pinned file preview | `artifacts.download({ version, range })` → version `content` |
| Exported folder files and changes | `artifacts.tree()`, `.file()`, `.diff()` → version `tree`, `files/{encodedPath}`, `diff` |
| Native streamed download | `artifacts.link({ version, file?, expiresIn: 60 })` → authenticated `POST /v1/artifacts/{id}/links`, then public `GET /v1/artifact-links/{token}` |
| Message attachments | `artifacts.upload(file, { name, sessionId, contentType })` → `POST /v1/artifacts?name=…&sessionId=…` (the proxy keeps only those two, checks `GET /v1/sessions/{id}`, needs `Content-Length`, refuses over `maxUploadBytes` only when the server sets one, none by default, and streams the body; the Runtime holds it to the Tenant's artifact limits); then `session.inputParts([text?, …{ type: "file", artifactId, version }])` → `POST /v1/sessions/{id}/commands`; any file is accepted (protocol 15) |
| Model inputs (Model settings) | Management `models.catalog()` → `GET /v1/tenant/models` (each model's `inputs` and `addableInputs`); `models.setInputs({ provider, model, inputs })` → `PUT /v1/tenant/models/inputs` (allowed by the proxy); a custom endpoint's `models.put({ settings: { inputs } })` |

The proxy allows these Agent routes and nothing else under them: `GET /v1/agents`
(with its filters and pages), `GET`, `PUT` and `DELETE /v1/agents/{id}`, `GET …/events`,
`GET …/versions`, `DELETE …/versions/{n}`, `GET …/secrets`, `GET`, `PUT` and
`DELETE …/secrets/{name}`, `GET …/memories`, `GET` and `DELETE …/memories/{path}`,
`GET …/memory_versions` and `…/memory_versions/{id}`, `GET …/triggers` and `…/runs`,
`POST …/triggers/{id}/pause`, `…/resume` and `…/run` (the one Agent write without a
JSON body; the proxy passes its `Idempotency-Key` on), and `POST …/stop`, `…/reset`,
`…/fork`, `…/snapshot` and `…/restore`; `GET /v1/agent-manifests`, `GET /v1/agent-manifests/{name}`,
`GET …/versions` and `GET …/versions/{n}`, and `PUT /v1/agent-manifests/{name}`
(`?dryRun=true` for the plan), whose `If-Match` it passes on. It no longer allows
`/v1/environments/**` or `/v1/environment-manifests/**`.

All version reads and download links name an explicit numbered version. Agent
IDs (which may hold `/`), secret names and folder file paths remain single encoded
path segments. Studio holds the
installation key on the server. The Runtime capability is the credential for a
native download, including in an embed; metadata and link minting still require
Studio authentication. Tokens expire after 60 seconds and are never logged by
Studio or put in application navigation state.

## Later work

Agent event reads currently return all events from a sequence. Studio reads
on opening Events and on explicit Refresh, accumulates by sequence, and never
polls or attaches an Agent SSE stream. Bounded event pages would improve large
histories, but are not a blocker for this increment.

Editing an agent manifest in Studio (a v8 document with its harness and runtime
sections, saved with `If-Match`) is deferred: the proxy allows the save, and the
SDK's `agentManifests.plan()` and `.save()` cover it.

Artifact version histories and folder trees are also ordinary existing reads.
Their pagination, lifecycle controls, uploads, deletion, share UI and live
workspace browsing are deferred (a disk version is browsable once kept). Do not introduce Studio-only data endpoints
or direct infrastructure access to fill these gaps.
