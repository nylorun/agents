# sandboxes

The sandboxes service (F7.2, D32): a small Go service that drives
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1.0.10 Sandboxes
(`agents.x-k8s.io/v1beta1`) in one namespace for one Tenant. It is the only holder of the
cluster credentials; the Runtime's core calls it with a bearer token. It keeps no state: the
operation id of the last apply is an annotation (`nylorun.dev/op`) on the Sandbox.

`nylorun sandbox enable --context <name>` installs what it needs into that context, writes
`<Host root>/sandboxes/cluster.json` and `token` (mounted read-only at
`/run/nylorun/sandboxes`), and adds the `sandboxes` service to the Tenant's Compose file.
With `--backend substrate` (preview, ADR-138) it drives [Agent Substrate](https://github.com/agent-substrate/substrate)
v1.0 actors instead, through Substrate's gRPC API (below).
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
`entrypoint` (`engine`, the default: the engine copied from `harnessImage` runs; `builtin`: the
engine the image carries under `/opt/nylorun` runs (`bin/tini`, `bin/node`, `engine/harness.mjs`,
ADR-99), with nothing copied in and no `harnessImage`; `image`: the image's own `ENTRYPOINT` and
`CMD` run, a custom harness built into the image, with nothing copied in and no `harnessImage`), `harnessImage` (the Runtime image the engine is copied from),
`command` (replaces the engine command, for diagnostics and the suite), `cpus`, `memoryMiB`, `storageGiB` (fixed once
created), `stopGraceSeconds` (1–30, default 10), `shutdownTime` (RFC 3339),
`shutdownPolicy` (`Retain`|`Delete`), `env`, `joinToken` (written to Secret `<name>-join`
before the Sandbox is applied).

Status: `name, exists, deleting, mode, ready, suspended, expired, podUID, podPhase, imageID,
volume (present|missing), opId, shutdownTime, reason, message`.

The pod shape is rendered only here (`internal/driver/sandbox.go`, golden file
`internal/driver/testdata/sandbox.golden.json`).

## Backend `substrate` (preview)

`cluster.json`'s `backend` is `agent-sandbox` (the default) or `substrate`, with a `substrate`
object: `atespace`, `systemNamespace` (`ate-system`), `apiService` (`api`), `serviceAccount`,
and `edge` (`host`, `harnessPort`, `gatesPort`). The `/v1/pods` contract is the same.

- **Reaching Substrate.** A port-forward to the `api` Service (or `endpoint`), TLS 1.3 against
  the live ClusterTrustBundle of Substrate's signer, and a token for the service's own
  ServiceAccount with audience `api.ate-system.svc`.
- **A pod is an actor** in the Tenant's atespace. Each incarnation gets an ActorTemplate
  `<name>-t<hash>`, its images pinned by digest (a HEAD to the registry), carrying the join token
  and the edge's CA; a new spec suspends the actor, repoints it and deletes the old template.
  `mode` maps to resume and suspend; `podUID` is the actor's UID, which the engine reads from
  Substrate's actor metadata. State (the last `opId`, `shutdownTime`) is a ConfigMap
  `<name>-state`. A sweep every 30 s applies `shutdownTime`. A resume that times out or finds Substrate busy is tried again every 5 s for 10 minutes while the sandbox's mode is still `Running` (a cold node's first resume pulls the image, which can outlast one 2-minute call).
- **The actor's resolver** gets `RES_OPTIONS=timeout:1 attempts:3` (an Agent's own value wins), so a restored actor's lost first DNS packet costs 1 s, not glibc's 5 s. The edge itself needs no lookup: the wrapper pins `<host address> <edge host>` in the actor's `/etc/hosts` at a fresh start, when the file is writable (Substrate keeps the actor's own edits to it across restores, and its egress routes the edge by TLS name).
- **Egress** is the Agent's network (`network` in the PUT body: `preset`, `hosts`, `suffixes`):
  the edge by TLS passthrough, each host on 443 (passthrough) and 80, or everything for `open`.
- **The edge** listens on `:8443` (to `http://runtime:4200`) and `:8444` (to
  `http://gateway:4100`) with `edge.crt`/`edge.key` from the directory, and passes WebSocket
  upgrades, which Substrate's egress does not.

Subcommands: `sandboxes edge-cert <host> <dir>` writes `edge-ca.pem`, `edge.crt` and `edge.key`;
`sandboxes substrate-setup` makes the atespace and its editor binding with an owner token from
`NYLORUN_SUBSTRATE_OWNER_TOKEN` or `NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE`. Both are run by `enable`.

## Environment

| Variable | |
| --- | --- |
| `NYLORUN_SANDBOXES_TOKEN` | the bearer token (required, ≥ 32 characters) |
| `NYLORUN_SANDBOXES_DIR` | where `cluster.json` and `token` are (default `/run/nylorun/sandboxes`) |
| `NYLORUN_SANDBOXES_LISTEN` | listen address (default `:4300`) |
| `NYLORUN_SANDBOXES_EDGE_HARNESS_LISTEN`, `_GATES_LISTEN` | the edge's listen addresses (substrate; `:8443`, `:8444`) |
| `NYLORUN_SANDBOXES_EDGE_HARNESS_UPSTREAM`, `_GATES_UPSTREAM` | where the edge forwards (`http://runtime:4200`, `http://gateway:4100`) |

`sandboxes healthcheck` probes `/ready` (the image has no shell).

## Develop

```sh
cd sandboxes && go vet ./... && go test ./...      # -update rewrites the golden file
docker build -f sandboxes/Dockerfile -t nylorun-sandboxes:dev .
npm run test:sandboxes:service -- --context docker-desktop   # or kind-nylorun --host-address 172.17.0.1
```
