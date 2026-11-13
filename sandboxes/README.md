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
| `GET /v1/pods/{name}` | the status; `?wait=ready\|suspended\|expired\|gone&timeoutMs=≤30000` blocks until then (on informer events with agent-sandbox; reading the actor every 250 ms with Substrate) and adds `met` |
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
and `edge` (`host`, `harnessPort`, `gatesPort`, `keysPort`), and `keysProvider` once keys at
Substrate's egress are on. The `/v1/pods` contract is the same.

- **Reaching Substrate.** A port-forward to the `api` Service (or `endpoint`), TLS 1.3 against
  the live ClusterTrustBundle of Substrate's signer, and a token for the service's own
  ServiceAccount with audience `api.ate-system.svc`.
- **A pod is an actor** in the Tenant's atespace. Each incarnation gets an ActorTemplate
  `<name>-t<hash>`, its images pinned by digest (a HEAD to the registry), carrying the join token
  and the edge's CA; a new spec suspends the actor (or reverts a crashed one), repoints it and
  deletes the old template. A repoint keeps the durable dirs (`/workspace`, `/harness`), and
  Substrate allows it only to a template with the same volumes. So an actor keeps the engine
  (the `nylo` image volume, pinned by digest) it was created with: a Runtime upgrade does not
  move an existing pod to the new engine; a new incarnation (a reset) gets it. Any other volume
  change, such as switching between `engine` and `builtin`, is not attempted: the request is
  recorded and the sandbox reports `reason: RepointRefused` with why, so the Runtime's ready
  deadline fails the start instead of the put being sent again for good.
  `mode` maps to resume and suspend (synchronous, so the snapshot is in durable storage when it
  returns); `podUID` is the actor's UID, which the engine reads from Substrate's actor metadata.
  State (the last `opId`, `mode`, template, image and any refusal) is a ConfigMap `<name>-state`: actors carry
  no labels to hold it. `shutdownTime` and `shutdownPolicy` are not applied (the Runtime sends
  none), so `expired` is never set. A resume is one `ResumeActor` call that may take up to
  5 minutes, the Runtime's own ready deadline (a cold node's first resume pulls the image, and
  cancelling the call would cancel the restore). It is tried again while Substrate is busy, or
  while the actor is still suspending, until a later request replaces it. An actor that crashed,
  or that a failed wake left crashed, is reverted to its last snapshot once and resumed
  (Substrate refuses to resume a crashed actor). Each resume logs `substrate resumed` with its
  time in `ms`.
- **The edge needs no DNS lookup in the actor:** the wrapper pins `<host address> <edge host>`
  in the actor's `/etc/hosts` at a fresh start, when the file is writable (Substrate keeps the
  actor's own edits to it across restores, and its egress routes the edge by TLS name). A
  restored actor's first lookup can be lost (P1.8).
- **Egress** is the Agent's network (`network` in the PUT body: `preset`, `hosts`, `suffixes`):
  the edge by TLS passthrough, each host on 443 (passthrough) and 80, or everything for `open`.
- **Keys** ([ADR-142](https://github.com/nylorun/factory/blob/main/decisions/platform/2026-11-13-substrate-egress-adds-keys.md)):
  with `keysProvider` set, each host in the PUT body's `keys` (`{sandbox, hosts: [{host,
  header}]}`, at most 200) becomes an `https` rule on 443 whose `replaceHeaders` entry names the
  header, an empty prefix, and the reference
  `ate-secret://keys.nylorun.dev/<base64url sandbox id>/<host>`; the host leaves the passthrough
  rule. Substrate's egress ends TLS with its own CA, which the template names in
  `NYLORUN_SANDBOX_EGRESS_CA_FILE` for the engine's trust bundle, and asks the keys provider.
  agent-sandbox ignores `keys` (egress-gate adds keys there).
- **The edge** listens on `:8443` (to `http://runtime:4200`) and `:8444` (to
  `http://gateway:4100`) with `edge.crt`/`edge.key` from the directory, and passes WebSocket
  upgrades, which Substrate's egress does not. With `edge.keysPort`, it also listens on `:8445`
  (to `http://gateway:4200`, egress-gate's decide route) for the keys provider; no actor's
  policy allows that port.

### The keys provider

`sandboxes provider` is the keys provider (ADR-142): the one credential provider Substrate's
egress asks for a keyed request's header, as a pod in `ate-system` beside it (`nylorun local
sandbox enable` deploys it as `nylorun-keys-provider`). Like Substrate's own providers, it serves
gRPC `FetchSecret` on `:50051` over mutual TLS with its servicedns pod certificate, admits only
the egress's identity (`--injector-identity`, default
`spiffe://cluster.local/ns/ate-system/sa/atenet-egress`), and reads values live. It stores
nothing and decides nothing:

1. the actor's atespace picks the Tenant in `--config` (`{tenants: {<atespace>: {decideUrl,
   token, edgeCa, outside?: {url, token, ca?}}}}`, a Secret);
2. it posts `{actor, sandboxId, host}` to the Tenant's decide route through the edge, with the
   token: the answer is a vault value, or `fetch` with the Agent, owner and host of a person's key;
3. for `fetch`, it posts `{agentId, owner, host}` to the outside credential source's `/v1/fetch`
   and returns its `value`; the Runtime never sees it.

A 403 or 401 answers `PermissionDenied` and a 404 `NotFound` (the egress answers 403); anything
else, or no answer within `--budget` (3 s), answers `Unavailable` (503). Logs name the sandbox,
host and outcome, never a value; `/readyz` on `:9091`. Substrate's egress learns it at Substrate's
install: `--credential-provider='[{"name":"keys.nylorun.dev","address":"nylorun-keys-provider.ate-system.svc:50051"}]'`.

Subcommands: `sandboxes edge-cert <host> <dir>` writes `edge-ca.pem`, `edge.crt` and `edge.key`;
`sandboxes substrate-setup` makes the atespace and its editor binding with an owner token from
`NYLORUN_SUBSTRATE_OWNER_TOKEN` or `NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE`. Both are run by `enable`.
`sandboxes provider` is the keys provider (above).

## Environment

| Variable | |
| --- | --- |
| `NYLORUN_SANDBOXES_TOKEN` | the bearer token (required, ≥ 32 characters) |
| `NYLORUN_SANDBOXES_DIR` | where `cluster.json` and `token` are (default `/run/nylorun/sandboxes`) |
| `NYLORUN_SANDBOXES_LISTEN` | listen address (default `:4300`) |
| `NYLORUN_SANDBOXES_EDGE_HARNESS_LISTEN`, `_GATES_LISTEN`, `_KEYS_LISTEN` | the edge's listen addresses (substrate; `:8443`, `:8444`, `:8445`) |
| `NYLORUN_SANDBOXES_EDGE_HARNESS_UPSTREAM`, `_GATES_UPSTREAM`, `_KEYS_UPSTREAM` | where the edge forwards (`http://runtime:4200`, `http://gateway:4100`, `http://gateway:4200`) |

`sandboxes healthcheck` probes `/ready` (the image has no shell).

## Develop

```sh
cd sandboxes && go vet ./... && go test ./...      # -update rewrites the golden file
docker build -f sandboxes/Dockerfile -t nylorun-sandboxes:dev .
npm run test:sandboxes:service -- --context docker-desktop   # or kind-nylorun --host-address 172.17.0.1
```
