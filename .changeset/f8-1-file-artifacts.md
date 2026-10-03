---
"@nylorun/core": major
"@nylorun/runtime": major
"@nylorun/agents": major
"@nylorun/admin": major
"@nylorun/cli": major
"nylorun": major
"@nylorun/studio": minor
"@nylorun/create-agent": patch
---

**File artifacts, message parts and capability links (protocol 6).** Upgrade these with the Runtime: they speak protocol 6, which this Runtime serves beside 4 and 5. See MIGRATION.md.

- **`@nylorun/runtime`: file artifacts.** A file is an artifact: an `af_` id, a name and numbered immutable versions, with rows in the new `artifacts` and `artifact_versions` tables (migration `0004_artifacts`) and bytes in the Object store (`BlobStore`). `POST /v1/artifacts?name=&sessionId=` uploads a file in one streamed request and `POST /v1/artifacts/{id}/versions` adds a version, within the Tenant's limits (`GET`/`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default); a body past either is `413 limit_exceeded`, refused mid-stream with nothing stored. `GET /v1/artifacts` lists them (by session), `GET /v1/artifacts/{id}` reads one with its versions, `GET /v1/artifacts/{id}/versions/{n|latest}/content` downloads through the Runtime with HTTP Range (`206`, `Content-Range`, `416`), and `DELETE /v1/artifacts/{id}` deletes it with its bytes. A session's artifacts go with it on a sessions reset, and appear in its history as `artifact.created`, `artifact.version.created` and `artifact.deleted` (new in the event catalog). A subject reaches only the artifacts of their own sessions.
- **`@nylorun/runtime`: capability links.** `POST /v1/artifacts/{id}/links` mints a short-lived path, `/v1/artifact-links/<token>`, that downloads one version (with Range) with no credential and no `Nylorun-Protocol`: an ES256 JWT (`typ: nylorun-artifact+jwt`) signed with the Tenant's signing key, at most 15 minutes, and dead once the artifact is deleted. The Host logs its path without the token.
- **Breaking (`@nylorun/core`, `@nylorun/runtime`): message `parts`.** A user message may carry `parts`: `text`, and `file` by `artifactId` (and `version`, else the latest, pinned when the message is accepted). Model-gate reads the file from the Object store: an image goes to the model as image input, a text file as text, and any other file fails the call (`invalid_request`). The record and the transcript hold only the reference. The gateway builds its `BlobStore` from `NYLORUN_OBJECT_STORE_*` (the Tenant's `fs` store without it). `PROTOCOL_VERSION` is 6; `HOST_PROTOCOL` is 4–6 and protocol 6 clients require the feature `artifacts`.
- **`@nylorun/runtime`: `save_artifact`.** A session with a sandbox gets the `nylorun.artifacts` capability, whose `save_artifact` tool saves a sandbox file (`path`) or text (`content`) as an artifact of the session, carrying the turn and tool call on its event.
- **Breaking (`@nylorun/runtime`): `MediaStore` is removed.** `MediaStore` and `localMedia` leave `@nylorun/runtime/node`, and `piModel` takes `files` (a resolver from an artifact reference to its bytes) instead of `media`; images are file artifacts. The image checks (`decodeImageBase64`, `validateImageBytes`, `IMAGE_MEDIA_TYPES`, `MAX_IMAGE_BYTES`) stay.
- **`@nylorun/agents`:** `client.artifacts` (`upload`, `uploadVersion`, `list`, `get`, `download` with a range, `link`, `delete`), also on `BrowserClient`, and `session.inputParts(parts)`. A request with a body of its own type keeps it.
- `@nylorun/admin`, `@nylorun/cli`, `nylorun`, `@nylorun/studio`: speak protocol 6.
