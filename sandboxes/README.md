# sandboxes

The sandboxes service: a small Go service that drives
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1.0.10 Sandboxes
(`agents.x-k8s.io/v1beta1`) in one namespace for one Tenant. It is the only holder of the
cluster credentials; the Runtime's core calls it with a bearer token. It keeps no state: the
operation id of the last apply is an annotation (`nylorun.dev/op`) on the Sandbox.

`nylorun sandbox enable --context <name>` installs what it needs into that context, writes
`<Host root>/sandboxes/cluster.json` and `token` (mounted read-only at
`/run/nylorun/sandboxes`), and adds the `sandboxes` service to the Tenant's Compose file.
With `--backend substrate` (preview) it drives [Agent Substrate](https://github.com/agent-substrate/substrate)
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
`entrypoint` (`engine`, the default: the engine copied from `harnessImage` runs; `image`: the
image's own `ENTRYPOINT` and `CMD` run, a custom harness built into the image, with nothing copied
in and no `harnessImage`; `builtin`, an engine built into the image, is refused: no image carries
the engine), `harnessImage` (the Runtime image the engine is copied from),
`command` (replaces the engine command, for diagnostics and the suite), `cpus`, `memoryMiB`, `storageGiB` (fixed once
created), `stopGraceSeconds` (1–30, default 10), `shutdownTime` (RFC 3339),
`shutdownPolicy` (`Retain`|`Delete`), `env`, `joinToken` (written to Secret `<name>-join`
before the Sandbox is applied).

**Image mirrors**:
`cluster.json`'s `imageMirrors` (the chart's `sandboxes.imageMirrors`) maps an image repository to
the repository that serves the same images, such as
`{"ghcr.io/nylorun/bot-computer": "asia-south1-docker.pkg.dev/<project>/nylorun/bot-computer"}`.
On both backends the workload image of a mapped repository is rendered from its mirror, with its
digest or tag kept (Substrate still pins a tag against the source registry first). The status's
`imageID`, and Substrate's recorded image, name the source repository, so the Runtime pins the
digest it asked for. The computer agent's and the Runtime's images are not mirrored. Copy each
digest into the mirror first (`crane copy` keeps it), and pre-pull the mirror's name. Keys and
values are repositories with no tag or digest; one mirror serves one repository.

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
  change, such as switching between `engine` and `image`, is not attempted: the request is
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
- **Suspend before drain** (Substrate's eviction contract, its API guide's "Eviction"): a worker
  pod that stops (a drain, a GKE upgrade or scale-down, a WorkerPool rollout, a deleted pod)
  sends each of its actors SIGTERM and gives them 30 minutes to be suspended; Substrate doesn't
  suspend them itself. The template sets `NYLORUN_SANDBOX_SUBSTRATE=1`, so the engine logs
  `harness_worker_stopping` and keeps running instead of exiting. The service watches every pod
  labelled `ate.dev/worker-pool` (cluster-wide `get`, `list`, `watch` on pods); when one turns
  Terminating, it suspends each of the Tenant's actors on it, synchronously, eight at a time,
  trying again for up to 29 minutes after the pod's deletion. It records the time as
  `drainedAt` in the state ConfigMap and the status, and resumes the sandbox when its request
  is `Running`: Substrate places it only on an ACTIVE worker, so on another one. Until then the
  status reason is `Moving`. Logs: `substrate drain: worker stopping`, `substrate drained` (with
  `ms`). Not covered: a spot reclaim (15 s to 2 min) or a node that dies, which still crash and
  revert. An actor keeps the engine it was created with (#643), so one made before this release
  still exits on SIGTERM until it is reset.
- **The edge needs no DNS lookup in the actor:** the wrapper pins `<host address> <edge host>`
  in the actor's `/etc/hosts` at a fresh start, when the file is writable (Substrate keeps the
  actor's own edits to it across restores, and its egress routes the edge by TLS name). A
  restored actor's first lookup can be lost (P1.8).
- **Egress** is the Agent's network (`network` in the PUT body: `preset`, `hosts`, `suffixes`):
  the edge by TLS passthrough, each host on 443 (passthrough) and 80, or everything for `open`.
- **Keys**:
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

### In the cluster, with computers

The Runtime's Helm chart runs the service in the cluster it drives. Its `cluster.json` sets
`inCluster: true` and `substrate.computer` (`{port}`, default 8080):

- **Reaching Kubernetes and Substrate.** The pod's own ServiceAccount; Substrate's API by its
  Service (`api.ate-system.svc:443`) with a projected token of audience `api.ate-system.svc`
  (`NYLORUN_SUBSTRATE_TOKEN_FILE`, default `/var/run/secrets/ate/token`) and the service-DNS
  signer's bundle (`NYLORUN_SUBSTRATE_CA_FILE`, default `/var/run/secrets/ate/ca.pem`, a
  `clusterTrustBundle` projected volume). No port-forward, no token it mints.
- **Every sandbox is a computer.** Its engine runs `--service computer` (no loop, no join, no edge):
  it serves commands and files on the computer port, and a wake-up probe on `/ready` makes
  `ResumeActor` return only once it answers. The template carries the public half of the ticket
  key (`NYLORUN_COMPUTER_TICKET_KEY_FILE`, default `/run/nylorun/computer/ticket.key`, PKCS #8 PEM
  Ed25519) for the engine to check tickets with. No join token is needed, there is no edge and
  no edge rule, and `entrypoint: image` is refused (a computer runs the Runtime's engine).
  `GET /v1/info` says `computer: true`.
- **What serves it** is `--computer-agent`: `go` (the chart's default) runs the computer agent
  (below) from `--computer-image`, `engine` (the service's default) the engine as above.

### The computer agent

`cmd/computer` is a static binary that serves a computer's routes in place of the engine's
`--service computer` (`runtime/server/src/harness/computer.ts`), with the same tickets and the same
answers. It ships alone in `ghcr.io/nylorun/computer:<protocol>.<n>` (`images/computer`, `FROM
scratch`, the file `/computer`), published by `computer-image.yml`, versioned by its protocol and
not with the Runtime.

- **The template** (`--computer-agent go`, entrypoint `engine`): the `nylo` image volume at `/nylo`
  is the agent's image instead of the Runtime's, and the container's command is `/nylo/computer`,
  run as the actor's PID 1 (no wrapper, tini or Node: it makes `/harness/home` and the workspace
  itself and reaps what commands leave behind). Everything else (env, volumes, the wake-up probe)
  is the engine's, and `command` replaces both. An actor
  keeps the agent image it was created with; a move between `engine` and `go` changes its volumes,
  which is refused (`RepointRefused`), so the Runtime gives it a new volume from its latest disk
  version. Golden file: `internal/substrate/testdata/computer-agent.golden.json`.
- **Routes:** `GET /ready` (no ticket; 503 `not_ready` unless the workspace is writable), and with
  `X-Nylorun-Ticket` (401 `unauthorized`, `Ticket refused: <reason>`): `GET /v1/info`, `POST
  /v1/exec` (start or join command `id`, answer within `waitMs`, at most 50 s: `running`, `done`
  or `failed`), `POST /v1/exec/{id}/attach`, `POST /v1/exec/{id}/cancel`, `GET`/`PUT /v1/files`
  (`maxBytes`: 413 `too_large`), `GET /v1/list` (`maxEntries`, `truncated`) and `POST /v1/disk`
  (one operation of the Runtime's disk versions on the computer's own workspace and
  `NYLORUN_HARNESS_ROOT`: list, read in ranges, clear or put; a path out of its root or naming the
  engine's own files is 400 `invalid_request`).
- **Commands** run under `/bin/bash -c` (`/bin/sh` without bash) in their own session, in the
  workspace or `cwd`. Environment: `PATH`, `LANG=C.UTF-8`, `TERM=dumb`, then the agent's own
  `PATH`, `LANG`, `TZ` and `LC_*`, then `HOME=/workspace`, then the request's `env`, then the trust
  variables. Each stream keeps its first 4 MiB and notes `… [N bytes dropped]`. A timeout kills the
  group with SIGKILL (124), a cancel too (130); a result is kept 10 minutes.
- **Trust:** with `NYLORUN_SANDBOX_EGRESS_CA_FILE` readable, the agent writes the image's CA bundle
  (the first of `/etc/ssl/certs/ca-certificates.crt` and the other usual paths) and that CA to
  `/tmp/nylorun-trust.pem` (`NYLORUN_COMPUTER_TRUST_FILE`), and points `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and
  `AWS_CA_BUNDLE` at it. The engine uses Node's built-in roots instead; a static binary has none.
- **Variables:** `NYLORUN_COMPUTER_PORT` (8080), `NYLORUN_COMPUTER_TICKET_KEY` (SPKI PEM),
  `NYLORUN_COMPUTER_NAME_FILE`, `NYLORUN_HARNESS_ROOT` (`/harness`, a disk root `/v1/info` names),
  `NYLORUN_SANDBOX_SUBSTRATE=1` (SIGTERM is logged as `computer_worker_stopping` and ignored), and
  for development `NYLORUN_COMPUTER_WORKSPACE`. It refuses to start holding a Runtime credential.
- **The contract test:** `internal/computer/testdata/contract.json` holds requests and answers;
  `go test ./internal/computer` runs them against the agent and
  `runtime/server/test/sandbox/computer-contract.test.ts` against the engine's `computerHandler`.
  A change to either side's answers changes the file. `images/computer/smoke.sh <image>` runs the
  image's binary in a plain Debian image.

### The sandbox gateway

`sandboxes gateway` is the computers' one way in, as its own Deployment with no
Kubernetes rights. It serves `/{sandbox}/{path}` on `:4400`: it checks the
`X-Nylorun-Ticket` header (a compact JWS core signs with the ticket key: `aud`
`nylorun-computer`, `sub` the sandbox's name, `exp`), opens an mTLS CONNECT tunnel to
`atenet-router.ate-system.svc:8444` with `ate-target-actor: <atespace>/<sandbox>` and authority
`<sandbox>:<computer port>`, and proxies the request inside it, ticket included, so the engine
checks it too. Its client certificate is a `podCertificate` projected volume
(`--credential-bundle`, read on each handshake) and the router's CA a `clusterTrustBundle` one
(`--router-ca`). Its SPIFFE ID must be the router's `--ingress-allowed-spiffe-ids` entry.
A ticket for another sandbox, an expired or a missing one is `401`; a tunnel the router refuses
is `502 computer_unreachable`.

### The keys provider

`sandboxes provider` is the keys provider: the one credential provider Substrate's
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
cd sandboxes && go vet ./... && go test ./...      # -update rewrites the golden files
docker build -f sandboxes/Dockerfile -t nylorun-sandboxes:dev .
docker build -f images/computer/Dockerfile --build-arg VERSION=1.0 -t nylorun-computer:dev .
bash images/computer/smoke.sh nylorun-computer:dev   # or BINARY=<built agent> without Docker
npm run test:sandboxes:service -- --context docker-desktop   # or kind-nylorun --host-address 172.17.0.1
```
