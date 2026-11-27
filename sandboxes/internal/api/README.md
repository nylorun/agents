# The sandboxes service's HTTP API

The API the Runtime's core calls, over whichever backend runs the Tenant's sandboxes: the same `/v1/pods` routes serve agent-sandbox's Sandboxes and Agent Substrate's actors. It holds the bearer token's check, the `?wait=` poll, and the `Backend` interface both drivers implement, so a backend only decides how a sandbox is put, read and waited for.

## Interface

- `Server` (`api.go`): `Handler()` returns the routes; fields `Driver` (a `Backend`), `Cluster` (`config.Cluster`), `Token` and `Log`.
- `Backend` (`api.go`): `Put`, `Delete`, `Status`, `Wait`, `Ping`, `Synced`.
- `Info` (`api.go`): `GET /v1/info`'s body: `backend`, `namespace`, `context`, `controllerVersion`, `apiVersion`, `hostAddress`, `ports`, `networkPolicy`, and with Substrate `atespace`, `substrateVersion`, `computer`.
- `MaxWait` (`api.go`): 30 s, the most `GET ?wait=` blocks.
- Routes (`api.go`): `GET /health`, `GET /ready`, `GET /v1/info`, `PUT /v1/pods/{name}`, `GET /v1/pods/{name}`, `DELETE /v1/pods/{name}`.

## Rules

- Every `/v1` route needs `Authorization: Bearer <token>`, compared in constant time over SHA-256 digests; a miss is `401 unauthorized` with `WWW-Authenticate: Bearer` (`api.go`, `auth`).
- `/health` is open and answers `{"status":"ok"}`; `/ready` is open and answers 503 with a reason until the backend has synced and its `Ping` answered within the last 5 s (`api.go`, `Ready`).
- The PUT body is one JSON object, at most 64 KiB, and an unknown field is `400 invalid_request` (`api.go`, `put`).
- `?timeoutMs` is capped at `MaxWait` (30 s), and `?wait` takes only the states `driver.Waits` names; the answer adds `met` to the status (`api.go`, `get`; `driver.Waits`).
- `/v1/info` reports `backend` as `agent-sandbox` when `cluster.json` names none, and `ateapi.v1` as `apiVersion` with Substrate (`api.go`, `info`).
- Any other route is `404 not_found`; every error is `{"error": {"code", "message"}}` (`api.go`).

## Side effects

- Calls the `Backend`: Kubernetes objects in the agent-sandbox backend, Substrate's API in the other (`api.go`).
- Writes one log line per PUT, and a warning per failed PUT (`api.go`, `put`).
- Reads the cluster's recorded configuration, never a file of its own (`api.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
