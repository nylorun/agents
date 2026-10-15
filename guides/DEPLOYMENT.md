# Runtime deployment

This release supports one machine: the **local Tenant** that `nylorun start`
runs for a project (the Runtime, its gateway and harness, Studio, Postgres, Restate,
s2-lite and RustFS, as Docker Compose project `nylorun-<tenant>`), an installation that
serves that one **Tenant**, and the services the application's agents call as
tools (HTTP tools and remote MCP servers) on the same machine or reachable from it. Vocabulary:
[runtime/server/src/CONTEXT.md](../runtime/server/src/CONTEXT.md).

```sh
npx nylorun start
npm run build
npm start
```

`nylorun start` in the project starts its Tenant (creating it and the Project
link the first time), or leaves it running when it already is, and
prints the Runtime and Studio URLs. `npm start` runs
`node dist/src/main.js`, which saves the application's agents to the Runtime
using two variables: `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY`, or through
the Project link. The Runtime runs no code of the application's during a session:
an agent's tools are HTTP tools and remote MCP servers, whose URLs must be
reachable from the Runtime (the local Tenant's containers map `localhost` to
this machine). In the project the SDK reads the Project link that `nylorun
start` wrote; a supervisor that starts the app elsewhere sets the two variables
instead, with a key of the app's own (`nylorun tenant keys put <id>`) and the
Runtime URL that `nylorun status` prints. The application does not
start the Tenant, Studio or a file watcher; start the Tenant first
(`nylorun start`), under the same supervisor if you use one.

Keep the Tenant's **Host root** (`~/.nylorun/tenants/<tenant>/`, or `NYLORUN_HOME`)
private and persistent across ordinary restarts: `tenant.json`, `host.json`, the admin key in
`host-credentials.json`, the Docker setup in `docker/` (`compose.yaml` and `.env`), the
Tenant directory `tenant/`, and the vault key in `keys/vault-kek`. Back up the
vault key with the Postgres volume: the Tenant's stored credentials cannot be
read without it. The Tenant's data lives in its
Docker volumes: Postgres (its database, schemas `nylorun` and
`nylorun_streams`), s2-lite (session history), Restate, RustFS (the Object store) and
the workspaces. Keep
each Project's `.nylorun/link.json` and `credentials.json` private as well;
model credentials live in the Tenant's vault. `nylorun stop` stops the
containers and keeps the volumes; `nylorun local reset` deletes the volumes, the
Tenant directory and the vault key, so the next start creates a new Tenant; `nylorun local delete
<tenant>` removes its containers, volumes and Host root altogether.

Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the
new Runtime. They described the previous host and are not supported deployment
paths for this beta.

To run an installation for a team with your own identity provider and secret
store, read [SELF_HOSTING.md](./SELF_HOSTING.md): the front doors, application
and management keys, the identity file, credentials, Studio behind a sign-in proxy, CORS,
private addresses and backups, with a runnable stack in
[examples/self-host](../examples/self-host/README.md).

## Serving people through an app server

To put agents in front of people, run your own **app server** (vocabulary in
[CONTEXT.md](../runtime/server/src/CONTEXT.md)): it signs people in, holds an
application key, and calls the Runtime API for each person with
`client.as(subject, { scopes })` or the AG-UI handler
([sdks/agents/README.md](../sdks/agents/README.md#acting-for-a-person-app-servers); a
complete web backend is in
[examples](../examples/README.md#an-agent-in-your-web-app-ag-ui)). The Runtime
enforces the scopes and each subject's ownership of sessions itself. Sessions
run in **Environments**: the app server creates them (one per person, per
project or per session, by an id it chooses), writes each one's secrets on the
Runtime API, and names one when it opens a session (`environment`)
([Environments](#environments), [Credentials](#credentials)).

- Keep the Runtime off the network. An app server on the same machine calls
  `http://localhost:<port>` (the URL `nylorun start` prints). An app server
  container joins the Tenant's Compose network and calls `http://runtime:4000`,
  which the Runtime already accepts as a `Host`. An app server on another
  machine reaches it through a reverse proxy:
  [Reaching the Runtime from another machine](#reaching-the-runtime-from-another-machine).
- Never publish the Runtime, Studio or Restate ports beyond loopback, and keep
  Studio for operators (loopback, an SSH tunnel, or
  [a sign-in proxy](#studio-behind-a-sign-in-proxy)). Restate's UI is not
  published at all unless you ask for it (`nylorun start --restate-ui`). Leave
  `NYLORUN_STUDIO_FRAME_ANCESTORS` empty on servers (the default): no page may
  frame Studio. Embedding is opt-in: `nylorun start --studio-embed-origin
  <origin>` lists the exact origins of the app that frames it.
- The app server drops every `Nylorun-*` header its own clients send, never
  forwards `Origin` (the Runtime refuses keys from browsers), and
  terminates TLS for its clients.
- The application key stays on the server; clients get nothing. Give each
  server its own application key (`npx nylorun tenant keys put <name>`, or
  `admin.keys.put(name)` in `@nylorun/admin` with a management key), so you can
  rotate or delete one without touching the others; the Runtime keeps only its
  hash. An app server needs no management key and never the admin key: an
  application key reaches only the Runtime API, so a leaked one cannot reset the
  Tenant, change its settings or rotate signing keys. It can write and delete
  Environments and their secrets, but no key reads a secret back. No key is derived from the admin
  key but Studio's: an earlier Host's derived keys are no longer registered, and
  those already in a database keep working as ordinary application keys until
  you replace them.
- Removing a person is the app server's decision: it stops acting for them and
  closes their open streams.

## Calling the Runtime from browsers and apps

A browser or a mobile app can call the Runtime itself, without carrying its
requests through your app server: it presents the JWT your identity provider
gave the person, and the Runtime trusts that provider through the identity
file ([Trusted issuers](#trusted-issuers)). There is no toggle and no browser
key: a request with an `Origin` and a trusted issuer's token is served like a
server's. Application keys are server secrets, refused with
an `Origin` (`403 origin_rejected`).

The Runtime sends no CORS headers. Put it behind a reverse proxy that answers
preflights and adds `Access-Control-Allow-Origin` for your app's origins only
([Reaching the Runtime from another machine](#reaching-the-runtime-from-another-machine));
an `OPTIONS` request that reaches the Runtime gets `204` with no CORS header,
so a page talking to it directly fails its preflight. A page served over HTTPS
can only call a Runtime served over HTTPS. Turn and rate limits per person
belong at the proxy too.

## Trusted issuers

The Runtime can accept JWTs from your own identity provider (Keycloak, Auth0,
Entra ID…) as bearers, from servers and browsers alike, with no Nylorun token
to mint (optional feature `trusted-issuers`). List the issuers in
`<Host root>/identity.yaml`; `nylorun start` then points the runtime at it
(`NYLORUN_IDENTITY_FILE=/nylorun/identity.yaml`). Elsewhere, set
`NYLORUN_IDENTITY_FILE` to the file's path. A change takes a restart.

```yaml
issuers:
  - name: keycloak
    issuer: https://sso.acme.dev/realms/eng      # the tokens' iss, exactly
    audience: https://agents.acme.dev            # the aud they must carry: the Runtime's public URL
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs  # or keys: [<PEM>, …]
    # Optional, with their defaults: {sub}, { claim: scope }, every scope but studio.
    subject: "u:{sub}"                           # the owner of the person's sessions; scalar claims only
    scopes: { claim: nylorun_scopes }            # or { fixed: [sessions:own, agents:read] }
    allowedScopes: [agents:read, sessions:own, environments:write, studio]
    agents: [support]                            # absent reaches every agent
    environments: ["users/{sub}/*"]              # grant templates; absent reaches none
```

- Tokens must be RS256, ES256 or EdDSA, at most 16 KiB, with `exp`; how long they live is
  the identity provider's setting.
  Their scopes are the claim's, limited to `allowedScopes` (`agents:read`,
  `sessions:own`, `environments:write`, and `studio`, an operator scope for
  Studio). An Environment grant whose
  claim is missing, or is not one id segment, reaches nothing. A file that still
  says `sandboxes:` or `sandboxes:write` (protocol 10) stops the runtime, naming
  the new spelling.
- A malformed file stops the runtime, naming the issuer and the field; a
  subject template must reference a claim, or everyone would be one person. A
  key the file does not define (such as `maxLifetime`, removed in protocol 9)
  is ignored and logged as `identity_file_key_ignored`.
- The Runtime publishes the issuers as OAuth protected resource metadata at
  `/.well-known/oauth-protected-resource` (RFC 9728), in the file's order, and
  every `401` points there. Set `NYLORUN_PUBLIC_URL` so its `resource` is the
  URL clients use.
- The runtime fetches only the configured JWKS URLs, without following
  redirects, and caches the keys. While a JWKS is unreachable, cached keys keep
  working and a token with a new `kid` gets `401 issuer_unavailable`; an
  unreachable JWKS never stops the boot.
- From a browser, the Runtime adds no CORS headers: your reverse proxy answers
  CORS. Only a token's expiry ends it (an open event stream ends then too);
  keep them short-lived, and revoke people at your identity provider.
- `GET /v1/me` shows what a token renders to (`via: issuer:<name>`), for any
  credential.

## Studio behind a sign-in proxy

Studio serves operators on loopback, where it needs no sign-in. To open it to a team, put a sign-in proxy
such as [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front
of it, signed in against an issuer from the identity file
([Trusted issuers](#trusted-issuers)).

1. Give the people who may use Studio the `studio` scope: list `studio` in the
   issuer's `allowedScopes`, and put it in their tokens' scope claim (or in
   `fixed`). Studio admits only tokens that carry it.
2. Run the proxy on the Studio machine, with Studio's published port as its
   upstream (`NYLORUN_STUDIO_PORT` in the Tenant's `docker/.env`) and the
   access token passed on:

   ```sh
   oauth2-proxy --provider=keycloak-oidc --oidc-issuer-url=https://sso.acme.dev/realms/eng \
     --upstream=http://127.0.0.1:<studio port> --pass-access-token=true \
     --pass-host-header=true --http-address=0.0.0.0:4180 …
   ```

   `--pass-access-token` sends the token as `X-Forwarded-Access-Token`; the
   token must be a JWT whose `iss` and `aud` match the identity file. When your
   provider's access tokens are opaque, pass the ID token with
   `--pass-authorization-header` instead and set the issuer's `audience` to the
   client id.
3. Start the Tenant with the proxy's host name, comma-separated if there are
   several: `NYLORUN_STUDIO_ALLOWED_HOSTS=studio.acme.dev nylorun start`. Studio
   then accepts that `Host` beside `localhost` and `127.0.0.1`; the proxy must
   pass the browser's `Host` through. Set it on every start: it is read from
   the environment, not kept.

Studio sends each forwarded token to the Runtime's `GET /v1/me` before it trusts
it. A token with the `studio` scope gets Studio's usual session cookie, which
names the person for Studio's log of state changes and ends no later than the
token; nothing else is kept. Without the scope Studio answers `403`; a token
the Runtime refuses gets `401`. Admitted people see the whole Tenant, as an
operator does. The cookie is `Secure` when the proxy sends
`X-Forwarded-Proto: https`; serve the proxy over HTTPS.

## Reaching the Runtime from another machine

When your app server runs on another machine (a laptop reaching a Mac mini on
the LAN, or a cloud backend reaching a server), put a reverse proxy in front of
the Runtime on the Runtime's machine. `nylorun start` publishes the Runtime on
`127.0.0.1` only and accepts only its own `Host` names, so the proxy is the one
way in. Nothing in the Runtime changes.

| Proxy rule | Why |
| --- | --- |
| Listen with TLS; forward to `127.0.0.1:<port>` (the port `nylorun start` prints) | A key travels on every request |
| Rewrite `Host` to `localhost:<port>` | The Runtime answers `421` to any other `Host` |
| Forward to the Runtime port only (`NYLORUN_PORT`); never Studio or Restate | Studio is for operators, behind its own sign-in proxy; Restate's UI has no authentication |
| Forward only `/health`, `/ready`, `/.well-known/oauth-protected-resource` and `/v1/*` | Nothing else is the Runtime API or the Management API; the well-known document tells OAuth clients where to sign in |
| Optional: answer `/v1/tenant/*` with `403` unless the request comes from your operator networks | Defense in depth for the Management API, on top of the key role |
| Pass every other header through: `Authorization`, `Nylorun-Protocol`, `Nylorun-Subject`, `Nylorun-Scopes`, and `Origin` | Your app server sets the `Nylorun-*` headers. The Runtime refuses keys sent with an `Origin` |
| Answer CORS yourself, for your app's origins only, when browsers call the Runtime: preflights (`OPTIONS`) and `Access-Control-Allow-Origin`; allow `Authorization`, `Content-Type`, `Nylorun-Protocol` and `Last-Event-ID`, and expose `Retry-After` and `WWW-Authenticate` | The Runtime sends no CORS headers (protocol 7); browsers present a trusted issuer's token |
| Don't buffer responses; allow idle streams | Event streams are long-lived SSE with a keepalive every 15 seconds |
| Restrict source addresses where you can; rate-limit at the edge | Limits scanning and guessing |

A [Caddy](https://caddyserver.com) configuration that does all of this
(replace the name and `8787` with your host name and the port `nylorun start`
prints):

```caddyfile
runtime.example.com {
	# Optional: the Management API only from your operator networks (replace the
	# range). One handle runs per request, the first that matches, so keep this
	# block first: a bare `respond` would run after the proxy, not before it.
	@management {
		path /v1/tenant /v1/tenant/*
		not remote_ip 10.20.0.0/16
	}
	handle @management {
		respond "Blocked by the reverse proxy" 403
	}

	@api path /health /ready /v1/*
	handle @api {
		reverse_proxy 127.0.0.1:8787 {
			# The Runtime answers only its own Host names.
			header_up Host localhost:8787
			# Event streams: flush every write.
			flush_interval -1
		}
	}

	handle {
		respond 404
	}
}
```

TLS by placement:

| Placement | Certificate | Notes |
| --- | --- | --- |
| Same LAN | Tailscale: name the site after the machine (`mac-mini.<tailnet>.ts.net`) and Caddy fetches its certificate from the local Tailscale daemon. Or a local CA (`tls internal`) whose root the app server trusts (`NODE_EXTRA_CA_CERTS`) | Never plain HTTP on a LAN or Wi-Fi: it exposes the key. With Tailscale, accept only the tailnet: add `@outside not remote_ip 100.64.0.0/10` with `handle @outside { respond 403 }` as the first block |
| Internet | A public certificate: Caddy obtains one automatically for a public DNS name | Prefer a private path (Tailscale, a VPN or the same cloud network) over a public endpoint; publish publicly only when the backend cannot join one |

On the app server's machine:

- Use an **application key**, never the admin key or a management key. On the
  Runtime's machine, `npx nylorun start` in the app's project starts the app's
  installation and links it. Give the app server a key of its own:
  `npx nylorun tenant keys put app-server` there prints one once.
  Keep the key in the app server's secret store.
- Set `NYLORUN_RUNTIME_URL` to the proxy's URL (`https://runtime.example.com`)
  for the client; keep `NYLORUN_SERVER_KEY` as printed. The services the
  agents' HTTP tools call must be at URLs the Runtime's machine can reach (the
  app server's address on the network, or a tunnel); allow that traffic.
- To check a placement end to end, run the remote check from a checkout of this
  repository on the app server's machine, against an installation made for it:

  ```sh
  npm ci && npm run build --workspace @nylorun/core --workspace @nylorun/agents
  node scripts/acceptance/remote.mjs --placement lan --fixture-model \
    --tools-url https://tunnel.example.com --tools-port 3000
  ```

  `--tools-url` is where the Runtime reaches the check's tool service (the HTTP
  tool its agent calls), which listens on `--tools-port` on the app server's
  machine (a tunnel, or the machine's address when the Runtime can reach it).
  The check verifies the proxy rules, runs a chat with an approval, drops the
  connection and reattaches, then keeps an event stream open through ten idle
  minutes (`--idle-minutes`) and checks that the Runtime still calls the tool
  afterwards. `--fixture-model` switches the Tenant's model calls to the
  Runtime's deterministic fixture model.

This is one Runtime on one server, operated by hand: no replicas, managed
backups, Helm charts or upgrade automation.

## Environments

A session runs in an **Environment** (protocol 11): one sandbox and one vault,
under an id the app chooses (`users/alice/web`, `projects/acme`), created with
`PUT /v1/environments/{id}` (`client.environments.put` in `@nylorun/agents`) and
named when a session opens (`environment: "<id>"`). A session that names none
has no sandbox and no credentials. An Environment is made from one version of an
[environment manifest](#environment-manifests) (`manifest: "analyst-box"`) or
from the same fields sent inline, and **never changes what it runs** after that
(protocol 14): a new version reaches an agent through a new Environment.
Upgrading from protocol 10, which had sandbox resources and vaults:
[MIGRATION.md](./MIGRATION.md#environments-replace-sandboxes-and-vaults-protocol-11-a-fresh-start).

- **Kind**, fixed when it is created: `virtual` (the default), an emulated bash
  with a virtual filesystem in the harness container (in the `runtime` container
  with `NYLORUN_HARNESS=in-process`), whose `/workspace` is kept under the
  Tenant's directory and which is not a VM or container boundary; `pod`, a
  container with its own volume on the Tenant's cluster, once sandbox pods are
  enabled (`nylorun local sandbox enable`), where its sessions' turns run; or `none`,
  a vault and no compute, for agents that use only remote MCP servers and HTTP
  tools.
- **What it runs** (`manifest` in its view, the fields 0.24 called its recipe):
  `image`, `resources` and `storage` (pods only), `network.allowedHosts`,
  `harness`, `lifecycle`, `setup`, `files` and `secrets` (slots), resolved
  against the Tenant's limits when it is made, with `manifestName`,
  `manifestVersion` and `manifestHash` saying where it came from. A `PUT` on an
  existing one may change only its labels and owner guard; fields that match
  what it runs are accepted, so get-or-create stays one call, and anything else
  is `409 environment_immutable` naming the fields. A restart, a reset or a
  lost pod rebuilds the same thing. Egress is limited to the hosts the
  Environment allows, within the Tenant's `limits.network`; private networks, loopback, the host and cloud
  metadata endpoints are always blocked. Each connection a pod opens, allowed or
  refused, is one `environment.egress` event on
  `GET /v1/environments/{id}/events?types=environment.egress` (host, port,
  outcome, bytes, duration and the turns running when it opened; never headers,
  paths or bodies). Session logs and turn traces hold no egress.
- **Lifecycle**: `lifecycle.idle` stops a pod after that long without a turn
  (at most the Tenant's `limits.idle`); `lifecycle.deleteAfter` deletes the
  Environment, its vault and its disk once it has gone that long unused (no
  turn, change, secret write, stop or reset). The default is never.
- **Owner guard**: with `ownerUserId` set, only that owner's sessions may name
  the Environment, checked when a session opens and at every turn start
  (`403 environment_owner_mismatch`; a caller acting for a person gets the
  `404` of a missing one).
- **Turns**: sessions on one Environment share its `/workspace` and run their
  turns at the same time; one turn per session. Which sessions work on one disk,
  and when, is your app's call: give work that must not share files its own
  Environment (or a fork). Stop, reset, snapshot and restore wait until no turn
  runs (`409 environment_busy`).
- **Who reaches it**: an application key reaches every Environment; acting for
  a person, changing one needs `environments:write`. A trusted issuer's token
  reaches only the ids its issuer grants (the identity file's `environments`
  templates). The Tenant holds at most `limits.environments` (default 100),
  set with `PUT /v1/tenant/sandbox` (Tenant setting `environments.config`).

- **Setup and input files** (pods): `files` copies versions of Tenant-wide
  artifacts in (a file artifact at its `path`, a folder artifact under it), then
  `setup` runs its commands in order (`/bin/sh -c`, in `cwd`, default
  `/workspace`; `timeout` default 10m, at most 30m; at most 16 of each), with the
  Environment's variables and secrets (as the sentinel) and its egress. They run
  once per disk: when the pod's volume is new (created or reset), before its
  first turn; a resume keeps what they made. A failed command fails the pod (`observed: failed`, reason
  `setup: command N …`, with its exit code and the end of its output in the
  `environment.failed` event) and the turn waiting for it; the next turn start
  runs the setup again.
- **Disk versions** (Host feature `environment-disk-versions`): between turns,
  `POST /v1/environments/{id}/snapshot` keeps a version of the disk
  (`/workspace`, and a pod's `/harness` but the engine's own files) as a version
  of a folder artifact the Environment owns: files with their modes and times,
  links and empty directories, each file's bytes stored once across versions.
  An unchanged disk makes no version (`unchanged: true`). `POST .../restore`
  with `{ version }` (or `"latest"`) puts one back: a virtual Environment at
  once, a pod on a new volume seeded from the version before its next turn
  (`disk.operation` in the view until then). `PUT` with
  `from: { environment, version }` creates an Environment whose disk starts as
  another's version (its vault starts empty). `GET .../versions` lists them,
  `DELETE .../versions/{n}` deletes one, and their trees, files, diffs and zips
  read through `/v1/artifacts/{artifactId}/versions/{n}/…`. A pod whose volume is
  lost and that has a version gets a new volume seeded from the latest one,
  instead of refusing turns until a reset. A snapshot or restore during a turn
  is `409 environment_busy`; a version holds at most 200,000 entries and 10 GiB,
  within the Tenant's artifact total. Deleting the Environment deletes its
  versions.

`GET /v1/environments?label=k=v` lists them, `POST .../stop` and `.../reset`
stop a pod or give it a new, empty volume, and `DELETE` removes the Environment
with its vault and files. `npx nylorun environments list | delete` does the same
from the command line (Runtime API, an application key), and
`npx nylorun doctor sandbox` reports the sandbox backend in use. Each Environment's lifecycle events (`environment.created`, `.attached`,
`.deleted`, a pod's `.running`, `.suspended`, `.lost`, …) are at
`GET /v1/environments/{id}/events`; a session's own log records
`environment.attached`, `environment.state` and `environment.exec`.

### Environment manifests

An **environment manifest** (protocol 14, Host feature `environment-manifests`)
is a named, versioned definition of a kind of Environment, saved like an agent
and written as a JSON file whose `$schema` is
`https://docs.nylorun.com/schemas/environment-manifest/v1.json`
(`@nylorun/core/schemas/environment-manifest.json`; clients drop `$schema`
before they save):

```json
{
  "$schema": "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
  "manifestSchemaVersion": 1,
  "name": "analyst-box",
  "kind": "pod",
  "image": "python:3.13-slim",
  "network": { "allowedHosts": ["pypi.org", "files.pythonhosted.org", "api.github.com"] },
  "setup": [{ "command": "pip install pandas", "timeout": "10m" }],
  "secrets": {
    "GH_TOKEN": { "type": "environment_secret", "allowedHosts": ["api.github.com"], "required": true }
  }
}
```

- **Saving.** `PUT /v1/environment-manifests/{name}`
  (`client.environments.manifests.save()`) writes its next version, or answers
  the latest `unchanged` when nothing differs. `If-Match: <version>` refuses the
  save (`412 manifest_changed`) when someone saved since you read it (`0` for a
  manifest that does not exist yet), and every version records who saved it
  (`savedBy`), from Studio, the CLI or the SDK alike. `?dryRun=true`
  (`manifests.plan()`) saves nothing and answers the plan: the changes, every
  reason the save would be refused (the Tenant's limits, files it cannot use),
  warnings (an image tag rather than a digest, kind `pod` with no sandbox pods)
  and how many Environments stay on older versions.
- **Making Environments.** `PUT /v1/environments/{id}` with
  `{ "manifest": "analyst-box" }` makes one from the latest version and pins
  it; `"analyst-box@3"` names a version. `labels`, `ownerUserId` and `from` may
  come with it, and no other field. **A save changes no Environment.**
- **Secret slots.** `secrets` declares what an Environment of the kind needs:
  each name, its type, its binding (`allowedHosts` and `inject`, or `url`,
  `via` and `identity`), whether it is required, and a description; never a
  value. The Environment's view lists each slot as set or missing. Write a value
  with `PUT /v1/environments/{id}/secrets/{name}` and `{ "value": "…" }` (or
  `{ "headers": { … } }`): the binding comes from the slot, so app code cannot
  widen where a key goes, and a name the manifest does not declare is
  `409 secret_not_in_manifest`. Inline fields may declare slots too.
- **What an agent needs.** An agent manifest's `requires`
  (`.requires({ sandbox: "pod", secrets: ["GH_TOKEN"] })`) is checked when a
  session opens: an Environment of the wrong kind, none at all, or a vault
  without one of the secrets is `409 environment_unsuitable` with
  `details.missing`. The agent still names no Environment.
- **Files by hash.** A `files` entry may name files by content hash instead
  of an artifact version: `{ "path": "/workspace/kit", "files": { "bin/run.sh":
  "sha256:…" } }` copies each file under `path` before `setup` runs. Upload
  each one first with `PUT /v1/files/sha256:<hex>` (at most 2 GiB);
  `environmentFiles(path, contents)` in `@nylorun/agents` hashes them and
  `manifests.save(manifest, { files: kit.bytes })` uploads what the Runtime
  lacks. A manifest by hash moves to another installation with its files.
- **The image, by digest.** The first time a pod of an Environment is ready,
  the Runtime records the workload image it pulled by digest (the view's
  `pod.imageDigest`), and every later pod of that Environment, after a stop, a
  relaunch or a reset, runs that digest: a tag that moves never changes what
  an Environment runs. A fork pulls the tag afresh. An image loaded onto the
  node without a registry pins nothing.
- **Forking onto a new version.** An Environment never changes what it runs,
  so it moves to a new version by a fork: `POST /v1/environments/{id}/fork`
  with `{ "id": "users/alice/analyst-2" }` (`client.environments.fork()`) makes
  a new Environment from the source's manifest at its latest version (or
  `manifest: "name@n"`). Its disk starts from a version of the source's
  (`disk: "latest"`, the default, snapshots first between turns; a version
  number; or `"empty"`), and the secrets the new manifest declares are copied
  inside the Runtime (`secrets: "none"` copies none); values never leave it.
  On a pod, the new version's setup runs on the copied disk before the first
  turn. The source keeps what it runs, its disk and its sessions: move them
  when you are ready. `dryRun: true` (`planFork()`) answers the plan: the disk,
  the secrets copied and left behind, required slots still missing, and the
  changes.
- **Versions and deleting.** `GET /v1/environment-manifests` lists each
  manifest's latest, `GET .../{name}/versions` every version with the
  Environments made from it, and `DELETE` removes all of them, refused while an
  Environment was made from one (`409 manifest_in_use`).

`PUT /v1/agents/{id}?dryRun=true` (`saveAgent(agent, { dryRun: true })`) checks
an agent's definition the same way and saves nothing.

## Postgres for session events

Postgres holds the record of every session event (`nylorun_streams.session_events`), and
the Runtime's stream relay feeds s2-lite from it over **logical replication**. A local
Tenant starts Postgres with the settings it needs; a Postgres you run yourself needs them
too:

| Setting | Value | Why |
| --- | --- | --- |
| `wal_level` | `logical` | The relay reads committed events from a replication slot. Changing it restarts Postgres |
| `max_replication_slots`, `max_wal_senders` | at least 2 (the default 10 is enough) | One slot, `nylorun_stream_relay`, and `nylorun_trace_export` when traces are exported |
| `max_slot_wal_keep_size` | a few GB (`nylorun start` uses 4GB) | A stuck relay cannot fill the disk; a lost slot only costs a reconciliation |
| The Runtime's role | `REPLICATION`, plus read access to `nylorun_streams` | The relay reads the Tenant's events (a local Tenant's `nylorun` role is a superuser) |

On a managed Postgres, turn on its logical replication option (for example
`rds.logical_replication` on RDS). With S2 down, commits continue and the slot keeps their
WAL; the relay catches up in order when S2 returns.

Postgres also carries the Runtime's control bus: a cancel or a sessions reset reaches every
Runtime process through `LISTEN`/`NOTIFY` on the channel `nylorun_control`, never through
S2. Each process holds one connection of its own for it (`application_name`
`nylorun-control`). Connect the Runtime to Postgres directly or through a pooler in session
mode: a pooler in transaction mode (PgBouncer's default) does not deliver notifications, and
a cancel then reaches another process only through the 5-second poll.

## Traces

Each turn is one OpenTelemetry trace, derived from the session log (track R7): a root span
`invoke_agent <agent>` for the turn, and a child span for every model call (`chat <model>`)
and tool call (`execute_tool <tool>`, a flow's HTTP stage too), plus a marker for each pause
and answer. Egress connections are not in a turn's trace: each is an `environment.egress` event
on its Environment's stream (`GET /v1/environments/{id}/events`), naming the turns running. Attribute names follow the OTel
GenAI semantic conventions at one pinned commit (`nylorun.semconv.genai` on the resource); the
rest are `nylorun.*`. Span ids are derived from the log under a key the Tenant keeps (its
setting `trace.key`), so exporting the same turn twice, or reading it from the route, gives the
same ids.

Export is off until an OTLP endpoint is set on the `runtime` container. `nylorun start` passes
these variables to it from the shell it runs in (a collector on your machine is
`host.docker.internal`):

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector's OTLP/HTTP base URL; spans go to `<url>/v1/traces` as JSON |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The full traces URL instead |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value` pairs separated by commas (values percent-encoded), sent with every post |
| `OTEL_SERVICE_NAME` | `service.name` on the resource; default `nylorun` |
| `OTEL_RESOURCE_ATTRIBUTES` | More resource attributes, `key=value` pairs |
| `NYLORUN_TRACE_CONTENT` | The content spans carry, any of `user`, `outputs`, `tool-results`, `errors`; none by default |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `true` turns on all four kinds |

- **Off the hot path.** With an endpoint, the process running core reads committed events
  from its own replication slot, `nylorun_trace_export` (the slot is created at start; one
  process reads it at a time), and posts batches of up to 512 spans, or every 2 s. No turn waits
  for it. Without an endpoint there is no slot.
- **A collector that is down costs only its spans.** A `429`, a `5xx` or a lost connection is
  tried three times with backoff, then the batch is dropped and logged as
  `trace_export_dropped {spans}`, and the slot moves on anyway, so Postgres keeps no WAL for the
  collector. Read the turns it missed from `GET /v1/sessions/{id}/turns/{turnId}/trace` and post
  them to the collector's `/v1/traces` to backfill.
- **What leaves.** By default a span carries references (`nylorun.event.cursor` points at the
  log event), never content. The content kinds above are each cut at 8 KiB. A span never carries
  a credential value (the log holds none), a prompt (the log holds none), a person's id
  (`ownerUserId`, a subject, who approved), an identity header or an idempotency key.
- **Trace context.** A command, an AG-UI run or an A2A message sent with a `traceparent` joins the
  caller's trace: the turn's root span is a child of the caller's span. The turn hands its own
  context on: to the harness (`TurnStart.trace`), to HTTP tools and MCP servers as `traceparent`
  on the call's requests, and to sandbox commands as `TRACEPARENT`.
- **Lag** is not reported yet: watch `nylorun_trace_export` in `pg_replication_slots`.

## The Object store

A local Tenant keeps file bytes in an **Object store**: RustFS, one node on one
drive, in the `rustfs` container on the `nylorun-<tenant>-rustfs` volume. Its
image is pinned by digest and upgraded only with a release. The Runtime reaches
it only through the S3 API (its `BlobStore` seam) and uses no RustFS-specific
feature, so S3 or any S3 server can replace it. Postgres stays the record: an
object counts only once a row in the Tenant's database refers to it. Back the
volume up with the Postgres volume.

- RustFS has no published port and no web console. Clients upload and download
  through the Runtime's API, never from RustFS directly.
- Its credential is the access key `nylorun` and a secret key that `nylorun start`
  generates once and keeps in `docker/.env` (`NYLORUN_OBJECT_STORE_SECRET_KEY`,
  mode 0600). Only the `runtime` and `gateway` containers receive it, as
  `NYLORUN_OBJECT_STORE_ENDPOINT`, `NYLORUN_OBJECT_STORE_ACCESS_KEY` and
  `NYLORUN_OBJECT_STORE_SECRET_KEY`. Studio, Postgres, Restate and s2-lite never see it.
- The runtime creates the bucket (`nylorun`, or `NYLORUN_OBJECT_STORE_BUCKET`) when
  it starts. `NYLORUN_OBJECT_STORE_REGION` sets the signing region (default
  `us-east-1`).
- A Runtime without `NYLORUN_OBJECT_STORE_ENDPOINT` (an embedded or ephemeral
  Runtime, tests) keeps the bytes on disk, under the Tenant directory's `blobs/`.
- `nylorun local logs rustfs` shows its log. RustFS uses about 75 MB of memory when idle.

## The gateway: model and tool calls

A local Tenant runs the Runtime image twice (the combined packing). The `runtime`
container runs the `core` and `loop` services: the APIs, Studio's backend and
the agent loop. The `gateway` container runs `gates`, the Model Gate: it reads
the Tenant's model credential from its vault and calls the provider. The loop
sends every vault-backed model call to it (`NYLORUN_GATES_URL`) and never holds
a model credential.

- The gateway has no published port; only the runtime and the harness reach it,
  on the Compose networks. It accepts two credentials:
  - **Core's credential**, `NYLORUN_GATES_TOKEN` from `docker/.env`. `nylorun start`
    generates it once and keeps it, and only the runtime container holds it. It
    is the only credential for vault writes and token signing, and it covers MCP
    requests the runtime makes outside a turn (closing a connection, for example).
  - **Run tokens**, the credential of the agent loop. Each time the runtime
    takes a session to advance it, it mints a short-lived token (15 minutes,
    renewed while the advance runs) naming that session, its turn and agent,
    and its ownership lease. Model calls accept only a run token, and the
    gateway takes the call's session, turn and agent from it, never from the
    request. Remote MCP and HTTP tool calls use it too. Once the turn is cancelled, a new turn
    starts or another runtime takes the session over, the gateway refuses calls
    under the old token with `409 run_stale`. A run token never reaches vault
    writes or token signing.
- It mounts only the Host root's `tenant/` and `keys/` directories, read-only
  (the Tenant's homes and its vault key), never `host-credentials.json`, and
  writes nothing there. It is not ready until `keys/vault-kek` is there;
  `nylorun start` writes it once, and moves the key a Host root of an earlier
  release kept in `tenant/vault-kek`.
- It reaches model servers on this machine (Ollama, for example) at
  `host.docker.internal`.
- While it is down, model calls fail with a retryable `transient` outcome and
  the session takes the next message; reads, commands and Studio keep working.
  `nylorun doctor` and `nylorun status` report it, and `nylorun local logs gateway`
  shows one `model_call` line per call (never the prompt, the output or a key).
- A model call outlives the runtime that sent it: if the runtime is killed or
  restarted mid-call, the gateway finishes the call and keeps its outcome for
  30 minutes, and the restarted runtime picks it up instead of calling the
  provider again. A gateway restart loses calls in flight.
- The gateway records every call in the Tenant's usage ledger
  (`GET /v1/tenant/usage`) and enforces the Tenant's hard caps
  (`PUT /v1/tenant/budgets`): once a cap is reached the turn fails with
  `model.budget_exhausted`. Prices come from pi-ai's model catalog, so cap a
  custom endpoint, which counts as $0, in tokens.
- The gateway reads the files a call names from the Object store, and sends a model only what it
  reads (protocol 12): its catalog's inputs plus those you add with `PUT /v1/tenant/models/inputs`
  (`admin.models.setInputs`), or a custom endpoint's `settings.inputs`, text only by default. A
  message naming a file the model does not read is refused when it is sent (`422
  attachment_unsupported`). A file goes to the model as bytes only in the turn that brought it;
  later turns name it by a reference line, and the model reads it again with `read_artifact`.
- A Compose file you write yourself must run both containers: in a container,
  a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and
  `NYLORUN_GATES_TOKEN`. A proxy between the two must allow an idle request of
  at least 630 s, because the gate answers only when the call has finished.

The gateway is also the Tool Gate. Tool calls that leave the loop cross it, so
the runtime container never holds an MCP credential or calls a tool's server:

- **Remote MCP servers** (`streamable-http` and `sse`): the gateway opens the
  connection, authorizes it from the vault of the session's Environment and runs
  `tools/list` and `tools/call`. `nylorun local logs gateway`
  shows one `mcp_request` line per request, never arguments, results or
  credentials. Nylorun accepts remote MCP servers only: there are no stdio
  servers to run.
- **HTTP tools**: the gateway POSTs every HTTP tool call, so it carries
  `NYLORUN_ENDPOINT_LOOPBACK` (and any other `NYLORUN_ENDPOINT_*` setting) and
  reaches services on this machine at `host.docker.internal`.
- A remote MCP call outlives the runtime that sent it, like a model call: a
  restarted runtime picks up its answer. The gateway records each call in the
  `tool_crossings` table before it reaches the server. A call a gateway restart
  interrupted is sent again with the same key, its effect id
  (`_meta["nylorun/idempotency-key"]`, or `Idempotency-Key` for an HTTP tool), up
  to three sends; then it fails to the model as `tool.interrupted`. Honor the key
  to make a side effect safe to repeat.

The gateway also runs `keys`, the only process that reads the vault key: it
runs every vault write that touches a secret (writing an Environment's
secret, setting and selecting the host model), signs every token
(capability links, run and host tokens, signing-key rotation) and runs MCP tool
previews, which send a vault credential. The runtime reaches
it at `NYLORUN_KEYS_URL` (by default the gateway's `NYLORUN_GATES_URL`) and
never reads the key: Compose covers `keys/` and `docker/` in the runtime
container with empty read-only mounts. While the gateway is down, those
requests answer `503 keys_unavailable`.

The combined packing suits one developer on one machine: the gateway holds
every secret of the Tenant in one process. Kubernetes splits it into separate
services in a later release.

## MCP servers and HTTP tools

An agent names its remote MCP servers and HTTP tools by URL, and its manifest never holds a
secret. Whoever sets up an Environment decides, per URL, how its sessions reach each one, with a
credential in the Environment's vault. The same agent can then use a key on a laptop and an MCP
gateway in production, with no change to its manifest. For each server:

1. **Write a credential** for its URL into the Environment ([Credentials](#credentials)), or none
   for a public server.
2. **Preview its tools** with that credential ([Previewing a server](#previewing-a-server)).
3. **Set its tools** in the agent's manifest: which are enabled and which are deferred
   ([Tools, results and errors](#tools-results-and-errors)). Which calls wait for a person is the
   Tenant's tool policy ([Tool policy](#tool-policy)).
4. **Name the Environment** on the sessions that need it: `environment` when your app server
   opens one. Check first that it covers the agent
   ([Checking an agent's credentials](#checking-an-agents-credentials)).

An agent with only remote MCP servers and HTTP tools needs no sandbox: give it an Environment of
kind `none`, a vault and no compute. Upgrading from protocol 10, which had user and installation
vaults: [MIGRATION.md](./MIGRATION.md#environments-replace-sandboxes-and-vaults-protocol-11-a-fresh-start);
from protocol 9, which had an MCP OAuth connect and a credential resolver:
[MIGRATION.md](./MIGRATION.md#mcp-credentials-from-vaults-only-protocol-10).

### Credentials

A session's MCP and HTTP tool credentials come from the vault of the session's Environment,
matched by the URL the agent names. A session without an Environment sends none. Each
Environment has exactly one vault, created and deleted with it; there is no vault shared between
Environments, so a key many Environments use is written into each.

Secrets are written on the Runtime API, by name: `PUT /v1/environments/{id}/secrets/{name}`
(`client.environments.secrets.put` in `@nylorun/agents`), with an application key, or acting for
a person with `environments:write`. `GET .../secrets` lists names, types and bindings, and
`DELETE .../secrets/{name}` removes one. A credential for a tool is bound to one URL, the one the
manifest names, and its name is a label (1–64 letters, digits, `.`, `_` and `-`). It is one of
two types:

| `type` | Body | Sends |
| --- | --- | --- |
| `bearer` | `{ type: "bearer", url, value }` | `Authorization: Bearer <value>` |
| `headers` | `{ type: "headers", url, headers: { … } }` | Every header of the map: an `x-api-key`, two keys at once (Datadog's API and application keys), or a scheme other than `Bearer` |

Either kind may add:

- **`via`**: where the requests go instead of `url`, such as a gateway. The manifest's URL still
  picks the credential, and tool names and diagnostics keep the manifest's server name. It is an
  `https` URL (plain `http` only to a loopback host) with no userinfo, query string or fragment,
  and the Host's address policy applies to it.
- **`identity: { header }`**: a header that carries the session owner's subject, for a gateway
  that keeps each person's accounts ([Reaching a person's accounts](#reaching-a-persons-accounts)).

Write one on the Environment's Secrets tab in Studio (Environments, then the Environment), with `@nylorun/agents`, or with
`PUT /v1/environments/{id}/secrets/{name}`:

```ts
await client.environments.secrets.put("projects/acme", "tickets", {
  type: "headers",
  url: "https://mcp.tickets.example/mcp",
  headers: { "x-api-key": process.env.TICKETS_KEY!, "x-account-id": process.env.TICKETS_ACCOUNT! },
});
```

- Values are sealed with the vault key and write-only. No answer, event or log line holds one: a
  credential is listed with its header names, `via` and identity header only.
- A `PUT` to an existing name replaces the credential: its value, URL, `via` and identity header
  together. The next request uses the new value.
- One URL has at most one credential per Environment: a second `bearer` or `headers` credential
  for the same URL is `409 credential_conflict` at the write.
- The transport's own headers (`Content-Type`, `Accept`, `Mcp-Session-Id`, …), `Idempotency-Key`
  and `Nylorun-*` are refused. A credential header replaces a manifest header of the same name.
- An MCP server with no credential in the Environment's vault is called without one: a server that
  needs one answers `401`, and `mcp.discovered` reports it for that session. An HTTP tool that
  names a `credential` the vault lacks fails with `http.credential`, and is not sent.

### Reaching a person's accounts

Nylorun holds no OAuth client, refreshes no token and asks no credential resolver (protocol 10).
A tool call acts either as the installation or as a person. What to add depends on what the
server takes:

| The server takes | The credential | In |
| --- | --- | --- |
| A key the person made, such as a personal access token (GitHub, Linear, Supabase) | `bearer` or `headers` | The person's own Environment |
| Only the person's sign-in, with OAuth (Notion, Slack, Gmail) | A gateway credential: the MCP gateway's key, `via` and an identity header | Each Environment whose sessions use the server |
| A client id and secret, exchanged for a short-lived token (MongoDB Atlas, Google service accounts) | A gateway credential | Each Environment whose sessions use the server |

In a survey of the 50 most used remote MCP servers (2026-10-07), half, and 7 of the top 10, took
only a person's sign-in, so an MCP gateway is how most installations reach a person's tools.

#### A person's own key

Give the person an Environment of their own, with the owner guard set to them, write their key
into it as a `bearer` or `headers` credential bound to the server's URL, and name it when your app
server opens their sessions:

```ts
await client.environments.put("users/alice/tools", { kind: "none", ownerUserId: "alice" });
await client.environments.secrets.put("users/alice/tools", "linear", {
  type: "bearer",
  url: "https://mcp.linear.app/mcp",
  value: process.env.ALICE_LINEAR_KEY!,
});
await client.createSession({ agentId: "triage", ownerUserId: "alice", environment: "users/alice/tools" });
```

A key acts as whoever made it: put a person's own token only in an Environment that only their
sessions may name (`ownerUserId`), and a key that acts for the organization in the Environments
your app gives everyone.

#### A gateway credential

An MCP gateway holds each person's sign-ins, refreshes their tokens, and asks a person who has not
connected an account yet to do so (most gateways return a link in the tool result, or through
MCP's URL elicitation, and the model passes it on). The installation reaches the MCP gateway
with one key, and the Runtime names the person in a header:

```ts
await client.environments.secrets.put("users/u_7c41/web", "notion", {
  type: "bearer",
  url: "https://mcp.notion.com/mcp", // what the manifest names
  value: process.env.GATEWAY_KEY!, // the gateway's key
  via: "https://gateway.internal/mcp/notion", // where the requests go
  identity: { header: "X-User-Id" }, // the session owner, filled in by the Runtime
});
```

For a session owned by `u_7c41`, Nylorun's Tool Gate sends:

```http
POST https://gateway.internal/mcp/notion
Authorization: Bearer <the gateway's key>
X-User-Id: u_7c41
```

- The identity header carries the session's `ownerUserId` as the Runtime stores it: the subject
  your app server names, or the `sub` of a trusted issuer's token. Set up the MCP gateway to know
  your people by that id.
- A session owned by `installation` (a scheduled or service session) sends no identity header.
  Check that your MCP gateway does not treat a missing id as an administrator or a default user.
- The value comes from the session record. Nothing the model or a manifest says changes it: the
  run token names no owner, and a manifest header of the same name is replaced.
- The MCP gateway's key can name any person. No call reads it back from a vault, and a `PUT`
  that changes its `via` must send a value too, so whoever can write an Environment cannot
  redirect a key they do not hold. Give it only the scopes your agents need, and rotate it like
  any other key (write it again into each Environment that holds it).
- Every tool argument and result passes through the MCP gateway.
- A `401` from the MCP gateway is `credential_rejected` to the model, and is not retried.

**What is tested.** The Runtime's tests run this shape end to end against a fake MCP gateway
(`runtime/server/test/r2b-exit.test.ts`): the key and the identity header reach `via`, the header is
absent for an installation session, and tools keep the manifest's server name. The vendor recipes
below were written from each vendor's docs on 2026-10-07 and have **not** been tested. Check each
one against the vendor's current docs before you rely on it.

**Arcade** (hosted; untested). One API key, and the person's id in `Arcade-User-ID`. Arcade stores
and refreshes each person's tokens, and asks for consent with URL elicitation.

```json
{ "type": "bearer", "url": "<the server's own URL>", "value": "<Arcade API key>",
  "via": "https://api.arcade.dev/mcp/<slug>", "identity": { "header": "Arcade-User-ID" } }
```

**ToolHive vMCP** (self-hosted, Apache-2.0; untested). Holds each person's upstream OAuth and
injects it. It checks OAuth tokens at its front door, so give the Runtime a service token it
accepts. How a call names the person was not clear from its docs: check that before you add an
identity header.

```json
{ "type": "bearer", "url": "https://mcp.notion.com/mcp", "value": "<a service token ToolHive accepts>",
  "via": "https://toolhive.internal/notion/mcp" }
```

**Obot** (self-hosted, MIT; untested). Manages MCP OAuth with per-person and shared credentials,
reached with a scoped API key. As with ToolHive, check how a call names the person.

```json
{ "type": "headers", "url": "https://mcp.notion.com/mcp", "via": "https://obot.internal/mcp/notion",
  "headers": { "Authorization": "Bearer <Obot API key>" } }
```

**Nylorun Cloud** (hosted; untested). Its MCP gateway takes a key per installation and the
identity header, and adds the person's credential from their connections. It is one gateway
among these: nothing in the open-source Runtime is specific to it.

```json
{ "type": "headers", "url": "<the server's own URL>", "via": "<the Cloud MCP gateway's URL>",
  "headers": { "x-api-key": "<installation key>" }, "identity": { "header": "<its user header>" } }
```

#### Gateways that mint something per person

Composio, Klavis, Smithery and Pipedream hold people's sign-ins too, but a call cannot name the
person with a header alone: each first mints something per person through its own API (a session
URL, a per-person server URL, a scoped token, or a token that expires within the hour). The
Runtime does not call those APIs. To use one, run a small proxy of your own in front of it:

- it accepts one key and the identity header from the Runtime;
- it mints, or takes from its cache, what the vendor needs for that person, and forwards the MCP
  request;
- the credential's `via` points at it, as for any gateway.

Keep the minted URLs and tokens out of logs, and out of any URL the Runtime sends (`via` takes no
query string). These were described from vendor docs on 2026-10-07 and have not been tested.

#### Servers that exchange a client id and secret

Some servers take a client id and secret that must be exchanged for a short-lived token (MongoDB
Atlas and Google service accounts, PayPal). An Environment's credential is a static header and the Runtime
refreshes nothing, so reach these through a gateway or a proxy that does the exchange, with a
`via` credential as above.

### Checking an agent's credentials

Before you open sessions, ask what a session of a saved agent would send in the Environment it
will name, with a management key:

```ts
const coverage = await admin.coverage({ agentId: "triage", environmentId: "projects/acme" });
for (const entry of coverage.entries) console.log(entry.status, entry.name, entry.message);
```

`POST /v1/tenant/credential-coverage` with `{ agentId, environmentId }` (Host feature
`credential-coverage`) lists every remote MCP server and every HTTP tool `credential` the agent
declares: its own, its subagents' and a flow's stages and agents. For each one, the Environment's
vault decides as a call would (the same URL comparison):

| `status` | A session would |
| --- | --- |
| `covered` | Send `credential` (its Environment, its name and its `via`) |
| `missing` | Call an MCP server without a credential, which only a public server accepts, or fail an HTTP tool with `http.credential` |

`complete` is true when every entry is `covered`. Without `environmentId` every entry is
`missing`, as for a session that names no Environment. Nothing reads a secret or calls a server.
Studio's **New session** runs this check for the Environment it picks.

### Previewing a server

```sh
nylorun tenant mcp inspect https://mcp.linear.app/mcp --server linear --environment projects/acme
```

`nylorun tenant mcp inspect <url> --environment <id>` connects with that Environment's credential for
the URL (its headers and `via`, never an identity header), or with none when you name no
Environment, lists the server's tools within 15 s, and calls none. So do
`admin.mcp.preview({ url, environmentId })`, `POST /v1/tenant/mcp/preview` with
`{ url, environmentId }` and **Preview tools** on an Environment's Secrets tab in Studio. It shows each tool's model name (as a manifest naming the server
`--server` would give it), its hints and the size of its input schema, and the tools renamed for
the model. A server that answers `401` needs a credential: the preview says so and shows the
server's sign-in metadata (RFC 9728), so you know to add a key or reach it through a gateway. Use
it to choose which tools to enable, and whether a server is large enough to defer.

### Tools, results and errors

Set an MCP server's tools in the agent's manifest, keyed by the server's own tool names, with `"*"`
for the rest ([sdks/agents/README.md](../sdks/agents/README.md)):

```ts
Agent({ id: "triage" }).mcp({
  github: {
    type: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    tools: {
      "*": { enabled: false }, // an allowlist: only the tools below
      search_issues: { enabled: true },
      create_issue: { enabled: true },
    },
  },
});
```

- **Enabled.** A disabled tool never reaches the model and is never called. A key that names no
  tool the server lists is reported in `mcp.discovered` (`unknownTools`), not refused.
- **Approval.** Not a manifest setting: the Tenant's [tool policy](#tool-policy) decides which
  calls wait for a person.
- **Deferred.** When an agent's MCP tools would take more than a tenth of the model's context
  window, the Runtime leaves them out of the model's tool list and gives it `tool_search` and
  `tool_call`, with a note naming each server. `deferred: true` or `false` on a tool, on `"*"` or
  on the server decides instead. The choice is made once per session, so the tool list is the same
  at every step.
- **Names.** The model knows a tool as `server__tool`, with characters outside `[A-Za-z0-9_-]`
  replaced by `_` (a dotted `issues.create` is `github__issues_create`). The server is still
  called by its own name.
- **Results.** A result past 32 KiB, and every image, audio or file part of one, becomes a file
  artifact of the session, and the model gets a preview and the artifact's id. It reads on with
  the built-in `read_artifact`, 32 KiB a call. These artifacts count toward the Tenant's artifact
  limits (`PUT /v1/tenant/artifacts`). An answer past 8 MiB is not kept.
- **Secrets.** A credential value a server echoes back is replaced with `[redacted]` before the
  model, an event or the Tool Gate's record sees it.

When a call fails, the model gets a failed tool result with a `code` and a `message` (and, for
an MCP call, `retryable`), and `tool.completed`'s `error` records the same:

| Code | When | Retryable |
| --- | --- | --- |
| `credential_rejected` | The MCP server, the MCP gateway or the HTTP tool's service answered `401` | No, and never retried: rotate the key, or have the person connect again at the MCP gateway |
| `mcp.unreachable` | The call was never sent: a refused address, DNS, a refused connection, TLS | Yes |
| `mcp.forbidden` | `403` | No |
| `mcp.error` | A JSON-RPC error, with its code in the message | No |
| `mcp.status` | Another HTTP error status | For `408`, `429`, `502`, `503` and `504` |
| `mcp.lost` | Sent, and the answer lost: the tool may have run, and the model decides whether to call it again | Yes |
| `mcp.too-large` | An answer past 8 MiB | No |

A tool's own error result (`isError`) is `mcp.tool`. `tool_call` answers `tool.unknown` for a
name no deferred tool has, and `tool.invalid-arguments` for arguments that do not match the
tool's input schema, without running it. An HTTP tool's other failures are `http.status`,
`http.timeout`, `http.refused`, `http.unreachable`, `http.lost`, `http.credential` and
`http.too-large`. A `credential_rejected` error names the server (or the HTTP tool's
`credential`), never a value.

### Tool policy

Which MCP and HTTP tool calls run, wait for a person, or are refused is the Tenant's tool
policy: yours to set, with a management key, for every agent and every harness at once.

```bash
curl -X PUT "$NYLORUN_RUNTIME_URL/v1/tenant/tool-policy" \
  -H "Authorization: Bearer $NYLORUN_MANAGEMENT_KEY" -H "Content-Type: application/json" \
  -d '{"rules": [
        {"effect": "ask", "tool": "github__create_issue", "reason": "A person files issues"},
        {"effect": "deny", "kind": "http", "tool": "refund_*", "when": {"amount": {"gt": 10000}}},
        {"effect": "ask", "agent": "triage", "server": "github"}
      ]}'
```

`admin.toolPolicy.get()` and `.put({ rules })` do the same from `@nylorun/admin`. A rule matches
a call when every selector it sets matches: `tool` (the name the model calls it by, such as
`github__create_issue`; `*` matches any run of characters), `server` (an MCP server's name),
`kind` (`mcp` or `http`), `agent` (the agent that calls it), and `when` (fields of the input by
dotted path, each tested with `equals`, `in`, `gt`, `gte`, `lt`, `lte` or `matches`). The
strictest rule that matches decides, whatever their order; a call no rule matches runs.

- **`deny`**: the call is never sent; the model gets `tool.denied`, with the rule's `reason`.
- **`ask`**: the turn pauses with the call's tool, input and reason (`turn.paused`, and
  `GET /v1/sessions/{id}/calls/tool` shows it `held`). An `approve` command on the session sends
  that exact call; a refusal fails it to the model as `tool.denied`, unsent. Nothing holds a
  process while it waits: an approval can come a day later, or after a Runtime restart. Studio
  shows an approval card on the session.
- **`allow`**: the call runs.

The Runtime decides as it journals the call, before anything is sent, and the gateway runs only
a call the journal holds running, so no harness can skip the policy. A policy that cannot be read
refuses every call. Sandbox tools never cross the gateway: control their network side with the
Environment's egress rules. A manifest no longer sets `approval`; a session pinned to one saved
with `approval: "always"` keeps it as an ask.

## Credentials for skills

A skill that runs a CLI (`gh`, `glab`, `aws`, `curl`) in a pod Environment authenticates with
a credential whose value never enters the sandbox. Two more secret types live in the same
Environment vault as MCP credentials; for both, the secret's name is the variable's name
(`PUT /v1/environments/{id}/secrets/GH_TOKEN`):

- **`environment_secret`** `{ type, value, allowedHosts, inject? }`: every command sees
  `$<name>` set to `nylorun-managed`, a fixed sentinel. When a command sends HTTPS to one of
  `allowedHosts` (exact host names, port 443), egress-gate sets the credential's header on each
  request: `inject.header` (default `Authorization`) with `inject.format` (default
  `Bearer {value}`; `{base64:…}` encodes a part, so `Basic {base64:x-access-token:{value}}`
  works). The value is read from the vault on every request, so a new value applies to the next
  one.
- **`environment_variable`** `{ type, value }`: a plain variable every command sees, such as a
  region or an organization name. Its value is not listed, but every command in the sandbox can
  read it.

```bash
curl -X PUT "$RUNTIME/v1/environments/users%2Falice%2Fweb/secrets/GH_TOKEN" \
  -H "Authorization: Bearer $NYLORUN_SERVER_KEY" -H "Nylorun-Protocol: 14" \
  -H "Content-Type: application/json" \
  -d '{"type":"environment_secret","value":"ghp_…","allowedHosts":["api.github.com","github.com"]}'
```

How it works: pods trust one installation egress CA (keys holds its key; the join answer
carries its certificate and the engine points `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and `AWS_CA_BUNDLE` at a bundle of the
public roots plus that CA). For a bound host, egress-gate terminates TLS with a short-lived leaf
for that host, sets the header and forwards the request over verified TLS to the address it
checked. Every other host stays an opaque tunnel. A CLI that pins certificates or ignores those
variables cannot use this path; HTTP/2-only and WebSocket endpoints are not served on it.

A second `environment_secret` bound to a host another one already has is refused at the write
with `409 credential_conflict`. Every session on the Environment gets its secrets, so set the
owner guard (`ownerUserId`) on an Environment that holds a person's own token. Pod Environments
only: a virtual one gets the variables but no header. A refused release is a `502` to the CLI and
an `egress_credential_refused` line in the gateway's log, never a session event. Write, replace
and delete them on an Environment's Secrets tab in Studio (type **Secret** or **Variable**), with
`client.environments.secrets` in `@nylorun/agents`, or on the Runtime API.

## The harness: agent turns, MCP servers and workspaces

The `harness` container runs the Runtime image a third time, as `--service
harness`. It runs every agent turn's engine and the session's workspace
(`bash`, `read`, `write` and the other sandbox tools), apart from
the runtime container, which keeps the Tenant's state and schedules the turns.
The runtime container runs no turn, no MCP server and no workspace command.

- It connects to the runtime's Harness API (`ws://runtime:4200/nylorun/harness/v1`)
  with the harness token, `NYLORUN_HARNESS_TOKEN` from `docker/.env`, which
  `nylorun start` generates once and keeps. Only the runtime (which checks it)
  and the harness hold it; the Runtime API, the Management API and the gateway
  refuse it. The harness holds no other credential: no database, no Restate, no vault
  key, no gates token. Its model and remote MCP calls go to the gateway with the
  run token of the turn they belong to.
- It mounts only the Tenant directory's `sandboxes/` (the workspaces) under
  `/harness`. It publishes no port and is healthy once it is
  connected (`nylorun status` shows `Harness  running, healthy, remote, 1
  connected`; `nylorun local logs harness` shows its log).
- If the harness container is killed mid model call, the gateway keeps the call
  and the restarted harness picks up its answer. A workspace command in flight is
  lost with the container: it fails to the model as `tool.interrupted`, and
  nothing runs it twice. If the runtime restarts, the harness connects again and
  the turn finishes.
- **Rollback.** Set `NYLORUN_HARNESS=in-process` in `docker/.env` and run
  `nylorun start`: the runtime container runs turns, MCP servers and workspaces
  itself again, and the harness container is removed. `NYLORUN_HARNESS=remote`
  (the default) brings it back; the setting is kept across starts.
- **Your own harness.** An Environment's `harness` names the harness that runs its
  sessions' turns (`nylorun` when unset). A harness of your own runs beside the
  Runtime with its own token (`nylorun-operate harness token put <id>` in the
  runtime container) or as a pod Environment's `image`. An Environment's
  harness is fixed for its life: to run another harness, save a manifest
  version that names it, fork the Environment onto that version, and open new
  sessions on the fork. A session pins its harness when it opens. If its
  Environment's id is deleted and made again with another harness, or an
  Environment changed in place before protocol 14 applies that change, the
  session's next turn is `409 harness_mismatch`: open a new session. See
  [HARNESS_API.md](./HARNESS_API.md).

## Networks and Restate's UI

A local Tenant has three Compose networks:

| Network | Members | Purpose |
| --- | --- | --- |
| `<project>-store` (internal: no egress) | postgres, s2-lite, restate, rustfs, runtime, gateway | The stores and Restate, reached only by the runtime and the gateway |
| `<project>-harness` | harness, runtime, gateway | The harness reaches the Harness API and the gateway, nothing else; it keeps egress for `bash` |
| `<project>` (default) | runtime, gateway, studio, sandboxes | Egress and the published ports |

Restate's admin API and UI (port 9070) have no authentication, so they are not
published. `nylorun start --restate-ui` (or `NYLORUN_RESTATE_UI=1 nylorun
start`) publishes them for that start on `127.0.0.1:<NYLORUN_RESTATE_PORT>` and
prints the URL; the next start without the flag closes them again.

## Container images

Each release publishes the Runtime and Studio as multi-arch images
(`linux/amd64`, `linux/arm64`), tagged with the package version:

| Image | Built from |
| --- | --- |
| `ghcr.io/nylorun/runtime:<runtime version>` | `runtime/Dockerfile` (the `runtime`, `gateway` and `harness` containers) |
| `ghcr.io/nylorun/studio:<studio version>` | `studio/Dockerfile` |

`nylorun start` runs the versions its release pins (`cli/nylorun/package.json`
`nylorun.runtime` and `nylorun.studio`) beside the official Postgres, Restate,
s2-lite and RustFS images. `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace
the pinned images, for example with a local build. Tags are never moved, and
there is no `latest` tag. Studio is not published to npm; it ships only as its
image.

Remote ingress, TLS, server deployment of these images (Compose on a server,
Helm), replicas, backups/migrations, crash recovery
qualification, and deployment automation are deferred. Local build and smoke
results do not establish those deployment guarantees.
