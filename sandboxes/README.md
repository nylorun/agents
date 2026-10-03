# sandboxes

The sandboxes service (F7.2, D32): a small Go service that drives
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1.0.5 Sandboxes
(`agents.x-k8s.io/v1beta1`) in one namespace for one Tenant. It is the only holder of the
cluster credentials; the Runtime's core calls it with a bearer token. It keeps no state: the
operation id of the last apply is an annotation (`nylorun.dev/op`) on the Sandbox.

`nylorun sandbox enable --context <name>` installs what it needs into that context, writes
`<Host root>/sandboxes/cluster.json` and `token` (mounted read-only at
`/run/nylorun/sandboxes`), and adds the `sandboxes` service to the Tenant's Compose file.
Image: `ghcr.io/nylorun/sandboxes:<runtime version>` (a change here needs a
`@nylorun/runtime` changeset; see RELEASING.md).

## API (`:4300`)

| Route | |
| --- | --- |
| `GET /health` | the process is up (open) |
| `GET /ready` | informers synced and the API server answers (open; the Compose health check) |
| `GET /v1/info` | `{namespace, context, controllerVersion, apiVersion, hostAddress, ports, networkPolicy}` |
| `PUT /v1/pods/{name}` | create or update; body below; a recorded `opId` is a no-op; returns the status |
| `GET /v1/pods/{name}` | the status; `?wait=ready\|suspended\|expired\|gone&timeoutMs=≤30000` blocks on informer events and adds `met` |
| `DELETE /v1/pods/{name}?opId=` | foreground delete (pod and claim go with the Sandbox) and the join Secret |

`/v1/*` needs `Authorization: Bearer $NYLORUN_SANDBOXES_TOKEN`. Errors are
`{"error": {"code", "message"}}`.

`{name}` is `sbx-<lowercase base32(sha256("<tenant>/<id>"))[:16]>-g<volumeGen>`
(`driver.Name`; `Name("shop", "sbx_01", 0)` is `sbx-ub6g5m7mvjlct6r7-g0`).

PUT body: `opId`, `mode` (`Running`|`Suspended`), `image` (default `python:3.13-slim`),
`harnessImage` (the Runtime image the engine is copied from), `command` (replaces the engine
command, for diagnostics and the suite), `cpus`, `memoryMiB`, `storageGiB` (fixed once
created), `stopGraceSeconds` (1–30, default 10), `shutdownTime` (RFC 3339),
`shutdownPolicy` (`Retain`|`Delete`), `env`, `joinToken` (written to Secret `<name>-join`
before the Sandbox is applied).

Status: `name, exists, deleting, mode, ready, suspended, expired, podUID, podPhase,
volume (present|missing), opId, shutdownTime, reason, message`.

The pod shape is rendered only here (`internal/driver/sandbox.go`, golden file
`internal/driver/testdata/sandbox.golden.json`).

## Environment

| Variable | |
| --- | --- |
| `NYLORUN_SANDBOXES_TOKEN` | the bearer token (required, ≥ 32 characters) |
| `NYLORUN_SANDBOXES_DIR` | where `cluster.json` and `token` are (default `/run/nylorun/sandboxes`) |
| `NYLORUN_SANDBOXES_LISTEN` | listen address (default `:4300`) |

`sandboxes healthcheck` probes `/ready` (the image has no shell).

## Develop

```sh
cd sandboxes && go vet ./... && go test ./...      # -update rewrites the golden file
docker build -f sandboxes/Dockerfile -t nylorun-sandboxes:dev .
npm run test:sandboxes:service -- --context docker-desktop   # or kind-nylorun --host-address 172.17.0.1
```
