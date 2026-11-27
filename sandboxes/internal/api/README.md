# The sandboxes service's HTTP API

The HTTP surface the Runtime's core calls: it turns a request into a call on a `Backend` and writes the sandbox's status back as JSON (`api.go:1-9`). Only core holds the bearer token; `/health` and `/ready` are open so a health check can probe the process (`api.go:1-2`).

## Interface

- `Handler` (`api.go:81-96`): the routes — `GET /health` (`api.go:83`), `GET /ready` (`api.go:86`), `GET /v1/info` (`api.go:87`), `PUT /v1/pods/{name}` (`api.go:88`), `GET /v1/pods/{name}` (`api.go:89`), `DELETE /v1/pods/{name}` (`api.go:90`).
- `Server` (`api.go:50`): the backend, the token and the logger its handlers use.
- `Info` (`api.go:62`): what `GET /v1/info` answers about the cluster.
- `Backend` (`api.go:38-47`): what the API needs of a driver — `Put`, `Delete`, `Status`, `Wait`, `Ping`, `Synced`.
- `MaxWait` (`api.go:35`): 30 s, the longest a `?wait=` may ask for.
- `Ready` (`api.go:116`): the check behind `GET /ready`.

## Rules

- Every `/v1/` route goes through the bearer check (`s.auth`, `api.go:87-90`); `/health` and `/ready` do not (`api.go:83-86`).
- `timeoutMs` is an integer from 0 to 30000: a negative value, a non-number or one above `MaxWait` is `400 invalid_request` (`api.go:201-206`).
- Without `?wait=` the answer is the status (`api.go:197`); with it, `{status, met}` (`api.go:214`).
- An unknown path answers `404 not_found` (`api.go:91-94`).
- Every answer is JSON and `Cache-Control: no-store` (`api.go:230-233`).

## Side effects

- Changes the cluster only through `Backend` (`api.go:38-47`); it holds no client of its own.
- Logs each delete with the sandbox's name and `opId`, at Info when it works and Warn when it fails (`api.go:222-226`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
