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
`node dist/src/main.js`, which saves the application's agent manifests to the
Runtime and makes their Agents, using two variables: `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY`, or through
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
run on **Agents**: the app server saves agent manifests, makes Agents from them
(one per person, per project or per audience, by an id it chooses), writes each
one's secrets on the Runtime API, and names one when it opens a session
(`agent`) ([Agents](#agents), [Credentials](#credentials)).

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
  Tenant, change its settings or rotate signing keys. It can save agent manifests
  and write and delete Agents and their secrets, but no key reads a secret back. No key is derived from the admin
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
    allowedScopes: [agents:read, sessions:own, agents:write, studio]
    agents: ["users/{sub}/*", support]           # Agent grant templates; absent reaches none
```

- Tokens must be RS256, ES256 or EdDSA, no longer than a request's headers may be (Node's `http.maxHeaderSize`, 16 KiB), with `exp`; how long they live is
  the identity provider's setting.
  Their scopes are the claim's, limited to `allowedScopes` (`agents:read`,
  `sessions:own`, `agents:write`, and `studio`, an operator scope for
  Studio); a token never saves agent manifests (`agent-manifests:write` is an
  app server's scope). `agents` lists the Agents its tokens reach: exact ids,
  prefixes ending in `/*`, templates such as `{org_id}/*`, or `*`; a grant whose
  claim is missing, or is not one id segment, reaches nothing. A file that still
  says `environments:` or `environments:write` (protocol 15), or `sandboxes:` or
  `sandboxes:write` (protocol 10), stops the runtime, naming the new spelling.
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
way in. Nothing in the Runtime changes but the URL it names itself by.

| Proxy rule | Why |
| --- | --- |
| Listen with TLS; forward to `127.0.0.1:<port>` (the port `nylorun start` prints) | A key travels on every request |
| Rewrite `Host` to `localhost:<port>` | The Runtime answers `421` to any other `Host` |
| Start the Runtime with the proxy's URL: `NYLORUN_PUBLIC_URL=https://runtime.example.com nylorun start` | Webhook URLs and the OAuth `resource` name it; without it they name `http://localhost:<port>` |
| Forward to the Runtime port only (`NYLORUN_PORT`); never Studio or Restate | Studio is for operators, behind its own sign-in proxy; Restate's UI has no authentication |
| Forward only `/health`, `/ready`, `/.well-known/oauth-protected-resource` and `/v1/*` | Nothing else is the Runtime API or the Management API; the well-known document tells OAuth clients where to sign in |
| Optional: answer `/v1/tenant/*` with `403` unless the request comes from your operator networks | Defense in depth for the Management API, on top of the key role |
| Pass every other header through: `Authorization`, `Nylorun-Protocol`, `Nylorun-Subject`, `Nylorun-Scopes`, and `Origin` | Your app server sets the `Nylorun-*` headers. The Runtime refuses keys sent with an `Origin` |
| Answer CORS yourself, for your app's origins only, when browsers call the Runtime: preflights (`OPTIONS`) and `Access-Control-Allow-Origin`; allow `Authorization`, `Content-Type`, `Nylorun-Protocol` and `Last-Event-ID`, and expose `Retry-After` and `WWW-Authenticate` | The Runtime sends no CORS headers (protocol 7); browsers present a trusted issuer's token |
| Allow request bodies as large as the Tenant's upload limits: an artifact (`POST /v1/artifacts`, 100 MiB by default, `/v1/tenant/artifacts`) and a skill file (`PUT /v1/files/sha256:…`, 2 GiB by default, `/v1/tenant/skills`). Caddy sets no limit; nginx's `client_max_body_size` is 1 MiB unless you raise it | A smaller limit refuses uploads, and `nylorun apply` and `agentManifests.save` for an agent with skill files |
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

## Agents

A session runs on an **Agent** (protocol 16): the live instance of one version of an
[agent manifest](#agent-manifests), with one environment of its runtime's kind (a sandbox, or
none), one vault, and the sessions that run on it, under an id the app chooses
(`users/alice/web`, `projects/acme`). It is made only from a saved manifest, with
`PUT /v1/agents/{id}` (`client.agents.put` in `@nylorun/agents`): `{ "manifest": "analyst" }`
tracks the manifest (its latest version now, and each version saved later), `"analyst@3"` pins
version 3. It runs **one version at a time and moves in place**: a `PUT` naming
another version moves it, a save moves every Agent that tracks the manifest, and each session's
next turn runs the version the Agent runs then. Its kind, harness and storage are fixed: a fork
changes those. Every session names its Agent when it opens (`agent: "<id>"`). No session is special: making an Agent opens none, and the
app picks session ids (to keep one conversation going, reuse one). Upgrading from protocol 15,
which had agent definitions, environment manifests and Environments:
[MIGRATION.md](./MIGRATION.md#agents-from-one-manifest-protocol-16-harness-api-5).

- **Kind**, the manifest's `runtime.kind`: `virtual`, an emulated bash with a virtual filesystem
  in the harness container (in the `runtime` container with `NYLORUN_HARNESS=in-process`), whose
  `/workspace` is kept under the Tenant's directory and which is not a VM or container boundary;
  `pod`, a container with its own volume on the Tenant's cluster, once sandbox pods are enabled
  (`nylorun local sandbox enable`), where its sessions' turns run; or `none` (also a manifest
  with no `runtime` section), a vault and no compute, for agents that use only remote MCP
  servers and HTTP tools.
- **What it runs** (`runtime` in its view): the manifest's runtime section, `image`,
  `resources` and `storage` (pods only), `network.allowedHosts`, `lifecycle`, `setup`, `files`,
  `limits` and `secrets` (slots), resolved against the Tenant's limits when it is made, with
  `manifest`, `resolvedVersion`, `manifestHash` and `tracking` saying where it came from and
  `harness` the harness that runs its loop (the manifest's `harness.id`, else `nylorun`). It
  moves between versions of its manifest in place: a pod applies a new runtime at its
  next start, on the same volume, and a start that fails (its setup, the pod, or longer than
  `tenant.upgradeStartMs`) goes back to the version it ran with its disk as it is; its kind,
  harness and storage are fixed (`409 agent_fixed_field`). A reset or a lost pod rebuilds what it
  runs. Egress is limited to the hosts the runtime allows, within the Tenant's
  `limits.network`; private networks, loopback, the host and cloud metadata endpoints are always
  blocked. Each connection a pod opens, allowed or refused, is one `agent.egress` event on
  `GET /v1/agents/{id}/events?types=agent.egress` (host, port, outcome, bytes, duration and the
  turns running when it opened; never headers, paths or bodies). Session logs and turn traces
  hold no egress.
- **Limits**: `limits.artifacts.fileBytes` and `limits.artifacts.totalBytes` cap the artifacts
  of the Agent's sessions and its disk versions, and `limits.skills.totalBytes` the files one
  skill of its manifest may hold (checked when the manifest is saved). Each is at most the
  Tenant's (`PUT /v1/tenant/artifacts`, `PUT /v1/tenant/skills`; a higher one is `400`), and one
  left out is the Tenant's as it is when checked. The Tenant's own totals still apply to
  everything; the view's `limits` says what is in force.
- **Lifecycle**: `lifecycle.idle` stops a pod after that long without a turn (at most the
  Tenant's `limits.idle`); `lifecycle.deleteAfter` deletes the Agent, its vault and its disk
  once it has gone that long unused (no turn, change, secret write, stop or reset). The default
  is never.
- **Owner guard**: with `owner` set, only that owner's sessions may run on the Agent, checked
  when a session opens and at every turn start (`403 agent_owner_mismatch`; a caller acting for
  a person gets the `404` of a missing one).
- **Turns**: sessions on one Agent share its `/workspace` and run their turns at the same time;
  one turn per session. Which sessions work on one disk, and when, is your app's call: give work
  that must not share files its own Agent (or a fork). A flow's child sessions run on its Agent.
  Stop, reset, snapshot and restore wait until no turn runs (`409 agent_busy`).
- **State**: the view's `state` is `working`, `sleeping`, `input_required`, `failing` or
  `paused`, with `attention` naming the sessions behind it, and `compute.state` its sandbox's
  (`ready`, `creating`, `running`, `stopped`); `GET /v1/agents?state=input_required` filters on
  it.
- **Who reaches it**: an application key reaches every Agent; acting for a person, changing one
  needs `agents:write`. A trusted issuer's token reaches only the ids its issuer grants (the
  identity file's `agents` templates). The Tenant holds at most `limits.environments` Agents
  (default 100), set with `PUT /v1/tenant/sandbox` (Tenant setting `environments.config`).

- **Setup and input files** (pods): `files` copies versions of Tenant-wide
  artifacts in (a file artifact at its `path`, a folder artifact under it), then
  `setup` runs its commands in order (`/bin/sh -c`, in `cwd`, default
  `/workspace`; `timeout` default 10m, at most the Tenant's `setupCommandMs`, 30m by
  default; at most `environmentSetupCommands` and `environmentFiles` of them, 16 each by
  default: [Runtime limits](#runtime-limits)), with the
  Agent's variables and secrets (as the sentinel) and its egress. They run
  once per disk: when the pod's volume is new (created or reset), before its
  first turn; a resume keeps what they made. A failed command fails the pod (`observed: failed`, reason
  `setup: command N …`, with its exit code and the end of its output in the
  `agent.failed` event) and the turn waiting for it; the next turn start
  runs the setup again.
- **Disk versions** (Host feature `environment-disk-versions`): between turns,
  `POST /v1/agents/{id}/snapshot` keeps a version of the disk
  (`/workspace`, and a pod's `/harness` but the engine's own files) as a version
  of a folder artifact the Agent owns: files with their modes and times,
  links and empty directories, each file's bytes stored once across versions.
  An unchanged disk makes no version (`unchanged: true`). `POST .../restore`
  with `{ version }` (or `"latest"`) puts one back: a virtual Agent at
  once, a pod on a new volume seeded from the version before its next turn
  (`disk.operation` in the view until then). `PUT` with
  `from: { agent, version }` creates an Agent whose disk starts as
  another's version (its vault starts empty). `GET .../versions` lists them,
  `DELETE .../versions/{n}` deletes one, and their trees, files, diffs and zips
  read through `/v1/artifacts/{artifactId}/versions/{n}/…`. A pod whose volume is
  lost and that has a version gets a new volume seeded from the latest one,
  instead of refusing turns until a reset. A snapshot or restore during a turn
  is `409 agent_busy`; a version holds at most 200,000 entries and 10 GiB,
  within the Tenant's artifact total. Deleting the Agent deletes its
  versions.
- **The image, by digest.** The first time a pod of an Agent is ready, the Runtime records the
  workload image it pulled by digest (the view's `compute.pod.imageDigest`), and every later pod
  of that Agent, after a stop, a relaunch or a reset, runs that digest: a tag that moves never
  changes what an Agent runs. A fork pulls the tag afresh. An image loaded onto the node without
  a registry pins nothing.
- **Forking.** An Agent's kind, harness and storage are fixed for its life, so a change to those
  is a fork: `POST /v1/agents/{id}/fork` with `{ "id": "users/alice/analyst-2" }`
  (`client.agents.fork()`) makes a new Agent from the source's manifest at its latest version
  (or `manifest: "name@n"`). Its disk starts from a version of the source's (`disk: "latest"`,
  the default, snapshots first between turns; a version number; or `"empty"`), and the secrets
  the new manifest declares are copied inside the Runtime (`secrets: "none"` copies none);
  values never leave it. On a pod, the new version's setup runs on the copied disk before the
  first turn. The source keeps what it runs, its disk and its sessions: move them when you are
  ready. `dryRun: true` (`planFork()`) answers the plan: the disk, the secrets copied and left
  behind, required slots still missing, and the changes.

`GET /v1/agents?label=k=v` (and `state`, `manifest`) lists them, `POST .../stop` and
`.../reset` stop a pod or give it a new, empty volume, and `DELETE` removes the Agent with its
vault and files (refused while a turn runs on it); its sessions keep their history, and their
next turn is refused (`agent_unavailable`). `npx nylorun agents list |
put | fork | rm` does the same from the command line (Runtime API, an application key), and
`npx nylorun doctor sandbox` reports the sandbox backend in use. Each Agent's lifecycle events
(`agent.created`, `.attached`, `.deleted`, `.forked`, a pod's `.running`, `.suspended`, `.lost`,
…) are at `GET /v1/agents/{id}/events`; a session's own log records `agent.attached`,
`environment.state` and `environment.exec`.

### Agent manifests

An **agent manifest** (v8, protocol 16) is one named, versioned document with what runs inside
the agent loop and what the Runtime provides around it: `harness`, the harness's `id` (`nylorun`,
ours, by default), `instructions`, `tools`, `skills`, `mcpServers`, `plugins`, `outputSchema`,
the agent's `model` (below) and the harness's own `loop` settings (ours reads `plan`: `true`
offers the agent `update_plan`, whose calls are `plan.updated` events; and `connections`: `true`
offers it `request_connection`, which pauses the turn on an interaction whose `metadata.kind` is
`connection`), or a flow (`kind: "workflow"`); and `runtime`, the
Agent's kind and what it gets (`image`, `network`, `setup`, `files`, `limits`, `lifecycle` and
the secret slots, `secrets`). Its JSON Schema is
`https://docs.nylorun.com/schemas/agent-manifest/v8.1.json` (v8 with `harness.model`; `v8.json`
is the same without it)
(`@nylorun/core/schemas/agent-manifest.json`; clients drop `$schema` before they save):

```json
{
  "$schema": "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
  "manifestSchemaVersion": 8,
  "name": "analyst",
  "harness": {
    "instructions": ["Analyse the data you are given with pandas, and show your numbers."]
  },
  "runtime": {
    "kind": "pod",
    "image": "python:3.13-slim",
    "network": { "allowedHosts": ["pypi.org", "files.pythonhosted.org", "api.github.com"] },
    "setup": [{ "command": "pip install pandas", "timeout": "10m" }],
    "secrets": {
      "GH_TOKEN": { "type": "environment_secret", "allowedHosts": ["api.github.com"], "required": true }
    }
  }
}
```

- **Saving.** `PUT /v1/agent-manifests/{name}` (`client.agentManifests.save()`, which takes a
  built agent and a runtime section too) writes its next version, or answers the latest
  `unchanged` when nothing differs. It needs `agent-manifests:write` acting for a person.
  `If-Match: <version>` refuses the save (`412 manifest_changed`) when someone saved since you
  read it (`0` for a manifest that does not exist yet), and every version records who saved it
  (`savedBy`), from Studio, the CLI or the SDK alike. `?dryRun=true` (`agentManifests.plan()`,
  `nylorun apply --dry-run`) saves nothing and answers the plan: each change by section and
  path, every reason the save would be refused, warnings (an image tag rather than a digest,
  kind `pod` with no sandbox pods), the Agents it would move and how many stay on older
  versions. **A save moves every Agent that tracks the manifest** to the new version: at once,
  at its pod's next start for a runtime change a pod applies only when it starts, or once a
  required secret the version adds is set. A pinned Agent stays, and so does one whose kind,
  harness or storage the version changes ([Agents](#agents)).
- **The agent's model.** `harness.model` (`model:` in `AGENT.md`) names the model the agent runs
  on, `<provider>/<model>` such as `anthropic/claude-sonnet-4-5` (the provider's id, a `/`, then
  the model's id, which may hold a `/` of its own; at most 200 characters). A session opened on a
  version that names one starts with it as its own model, as if `PUT /v1/sessions/{id}/model`
  had chosen it, when the provider is connected and its catalog lists the model (any model for
  `custom`); otherwise the session has no model of its own and the Tenant's applies, and nothing
  fails. Only a new session takes it: an open session keeps its model when a later version names
  another, and an explicit choice replaces it. Agents under `agents/` run on the root agent's.
  Host feature `agent-model`.
- **Its sections must fit.** The Runtime checks the two against each other and refuses every
  gap at once (`422 manifest_inconsistent`, `details.gaps`): a custom harness needs
  `runtime.kind` `pod` with an `image`; an MCP server's, HTTP tool's, flow HTTP stage's or HTTP
  verifier's `credential` (an embedded agent's too) must name a `bearer` or `headers` slot of
  `runtime.secrets` bound to its exact URL; a skill's `secrets`
  must name `environment_secret` or `environment_variable` slots; skills need a sandbox
  (`virtual` or `pod`). It also refuses what the Tenant's limits do not allow, files it does not
  hold, a tool that runs your code and a tool's `approval` (the Tenant's
  [tool policy](#tool-policy) decides).
- **Agent folders.** Author a manifest as a folder (tracks T6 and T7, format `agent-folder/1`):
  `AGENT.md` (frontmatter `name` and `description`, optionally `model: <provider>/<model>`, the
  instructions below), `mcp.json` (Agent
  Plugins syntax; `Authorization: Bearer ${NAME}` names a `bearer` slot, derived for the server's
  URL when `runtime.json` declares none), `runtime.json` (which may `"extends"` a shared file),
  `skills/<name>/`, HTTP `tools/<name>.json`, `triggers/<id>.md`, `files/**`, subagents in
  `agents/<id>/`, a flow in `flow.json` and vendored Agent Plugins in `plugins/<name>/`; a
  `.nyloignore` leaves files out. The [CLI's README](../cli/nylorun/README.md#agent-manifests-apply)
  shows each. Each kind of file has a JSON Schema at
  `https://docs.nylorun.com/schemas/agent-folder/v1/<kind>.json` (`runtime`, `tool`, `mcp` and
  `flow`, and `agent-md.1` and `trigger-md` for the frontmatter), exported as
  `@nylorun/core/schemas/agent-folder-<kind>.json`.
  `nylorun init <path>` writes one, `nylorun check` compiles it offline and prints every problem by
  file, line and column, and `nylorun apply` (or `saveFolder` in `@nylorun/agents`) sends it by
  hash with `Content-Type: application/vnd.nylorun.folder+json`. The Runtime compiles it with the
  same compiler (`@nylorun/core/folder`; `422 folder_invalid` when it does not compile) and keeps
  it as the version's source: `GET /v1/agent-manifests/{name}/versions/{v}/source` lists its
  files, `.../source/files/{path}` returns one, and `GET /v1/agent-manifests/{name}/source/diff?from=&to=`
  lists the files added, removed and changed between two versions' sources. A change outside the
  agent, such as a README, answers `unchanged`. What a folder may hold is the Tenant's
  [Runtime limits](#runtime-limits) `folderFiles`, `folderBytes` and `folderTextFileBytes`.
  `nylorun pull` writes back the folder a version was saved from, and `nylorun export --folder`
  writes one for a version saved as JSON. The analyst above as a folder, with a skill that reads
  `GH_TOKEN` ([Credentials for skills](#credentials-for-skills)) and a weekly trigger:

  <!-- doc-test: folder analyst AGENT.md -->
  ```markdown
  ---
  name: analyst
  description: Analyses data with pandas.
  skills:
    github-issues:
      secrets: [GH_TOKEN]
  ---
  Analyse the data you are given with pandas, and show your numbers.
  ```

  <!-- doc-test: folder analyst skills/github-issues/SKILL.md -->
  ```markdown
  ---
  name: github-issues
  description: Lists a repository's open issues with the gh CLI.
  ---
  Run `gh issue list --repo <owner/repo> --state open --json number,title,labels` and count the
  issues by label.
  ```

  <!-- doc-test: folder analyst runtime.json -->
  ```json
  {
    "kind": "pod",
    "image": "python:3.13-slim",
    "network": { "allowedHosts": ["pypi.org", "files.pythonhosted.org", "api.github.com"] },
    "setup": [{ "command": "pip install pandas", "timeout": "10m" }],
    "secrets": {
      "GH_TOKEN": { "type": "environment_secret", "allowedHosts": ["api.github.com"], "required": true }
    }
  }
  ```

  <!-- doc-test: folder analyst triggers/weekly.md -->
  ```markdown
  ---
  schedule: "0 9 * * 1"
  timezone: Europe/London
  session: new
  ---
  Summarize last week's numbers in /workspace/sales.csv in five lines.
  ```
- **Three files (deprecated).** A manifest may still be authored as `agent.manifest.json`, naming a
  `harness.manifest.json` (whose `credentials` maps a server or HTTP tool to its slot, and whose
  `requires` the composer checks) and a `runtime.manifest.json` that many agents may share, by
  path. `nylorun apply <dir>` and `composeManifest(dir)` in `@nylorun/agents` compose them into
  one document and upload the files they name; their JSON Schemas are
  `@nylorun/core/schemas/harness-manifest.json` and `runtime-manifest.json`, and `nylorun
  migrate v8` writes them from a v7 agent manifest and an environment manifest. `apply` and
  `composeManifest` warn on them: `nylorun migrate folder <dir>` writes the agent folder of a
  three-file folder, offline.
- **Secret slots.** `runtime.secrets` declares what an Agent made from it needs: each name, its
  type, its binding (`allowedHosts` and `inject`, or `url`, `via` and `identity`), whether it is
  required, and a description; never a value. The Agent's view lists each slot as set or
  missing. Write a value with `PUT /v1/agents/{id}/secrets/{name}` and `{ "value": "…" }` (or
  `{ "headers": { … } }`): the binding comes from the slot, so app code cannot widen where a key
  goes, and a name the manifest does not declare is `409 secret_not_in_manifest`.
- **Files by hash.** A `files` entry may name files by content hash instead
  of an artifact version: `{ "path": "/workspace/kit", "files": { "bin/run.sh":
  "sha256:…" } }` copies each file under `path` before `setup` runs. Upload
  each one first with `PUT /v1/files/sha256:<hex>` (at most the Tenant's skill
  limit, `PUT /v1/tenant/skills`, default 2 GiB);
  `runtimeFiles(path, contents)` in `@nylorun/agents` hashes them and
  `agentManifests.save(manifest, { files: kit.bytes })` uploads what the Runtime
  lacks, as it does a skill's files. A manifest by hash moves to another installation with its
  files.
- **Versions and deleting.** `GET /v1/agent-manifests` lists each manifest's latest,
  `GET .../{name}/versions` every version with the Agents made from it, and `DELETE` removes all
  of them, refused while an Agent was made from one (`409 manifest_in_use`). Model budgets of
  scope `manifest` (`PUT /v1/tenant/budgets`) cap a manifest's calls by its name.

### Triggers, webhooks and wakes

An Agent starts turns with no client connected from what its manifest's
`runtime.triggers` declares, by id. Each trigger has exactly one of `schedule` (five-field cron,
in `timezone`, an IANA name, UTC by default), `at` (one time, RFC 3339 with an offset) or
`webhook` (`"standard-webhooks"`), and the `session` its runs go to and its `prompt`:

```json
"runtime": {
  "kind": "none",
  "triggers": {
    "hourly-check": { "schedule": "0 * * * *", "timezone": "Asia/Kolkata", "session": "triage-inbox", "prompt": "Check for new issues." },
    "alerts": { "webhook": "standard-webhooks", "session": "new", "prompt": "An alert arrived. Investigate it." },
    "launch-day": { "at": "2026-11-01T09:00:00+05:30", "session": "launch", "prompt": "Post the launch checklist." }
  },
  "selfWake": true
}
```

- **Sessions.** `session` is a session id of the Agent, opened by the trigger's first run (owned
  by the Agent's owner, or `installation`) and open to people and apps like any session, or
  `"new"` for a session per run (`run-<runId>`). A named session that belongs to another Agent
  fails the run (`session_conflict`).
- **Runs.** Each time a trigger fires is a run, at `GET /v1/agents/{id}/runs`
  (`nylorun agents runs`): `started` a turn, `queued` behind a running turn, `skipped`
  (`overlap`, `rate_limited`, `paused`) or `failed`. A trigger fires on the Runtime's durable
  timers, with Postgres holding when each one is due: after downtime it fires once, marked `late`,
  and never backfills the times it missed. A schedule's runs move by a fixed offset per trigger
  (`triggerJitterPercent`). A schedule adds at most one queued run to a busy session; its later
  fires are skipped (`overlap`).
- **Status.** Triggers start active with a new Agent; a trigger a newer version adds arrives
  `paused` (`new`). `GET /v1/agents/{id}/triggers`, `POST .../triggers/{id}/pause`, `/resume`
  and `/run` (with an `Idempotency-Key`), and `nylorun agents triggers`.
- **Webhooks.** A webhook trigger's endpoint is `webhookUrl`, `POST /v1/webhooks/{endpointId}` at
  `NYLORUN_PUBLIC_URL` (else the origin the request reached):
  no credential and no protocol header, Standard Webhooks signatures (`webhook-id`,
  `webhook-timestamp` within `triggers.webhookToleranceMs`, `webhook-signature`), any body up to
  `webhookBodyBytes`. Make its signing secret with `POST .../triggers/{id}/secret`
  (`nylorun agents triggers new-secret`); it is shown once and replaces the one before. Relay
  GitHub, Stripe or Slack through your app, signing with that secret. The payload reaches the
  model under the prompt, labelled as data from an outside sender; it never approves anything.
  Put a Runtime that faces the internet behind a proxy that limits requests to `/v1/webhooks/`.
- **Wakes.** `"selfWake": true` offers the agent `schedule_wake`: it books its session's next turn
  (`in` or `at`, and a `note` that is that turn's message), one booking per session.
- **The session queue.** A message to a session whose turn runs is queued and starts the next
  turn (protocol 17); `delivery: "reject"` answers `409 session_busy` instead. AG-UI and A2A
  refuse it, as before: a run or a task is the turn it starts (AG-UI's `RUN_ERROR`
  `session_busy`, A2A's `UnsupportedOperationError`).
- **Limits.** `triggersPerAgent`, `triggerMinIntervalMs`, `triggerRunsPerHour` (the guard against
  an Agent triggering itself), `triggerPromptChars`, `triggerRunRetentionMs`, `wakeMaxAheadMs`,
  `wakeNoteChars`, `webhookBodyBytes` and `sessionQueuedMessages` ([Runtime limits](#runtime-limits)).
  An hourly trigger on a hundred Agents is 2,400 turns a day: set model budgets before leaving
  Agents running unattended.

### Agent memory

An Agent keeps memory across sessions, wakes and upgrades when its manifest turns it on:

```json
"harness": {
  "memory": { "access": "read_write", "instructions": "Keep the team's release conventions." }
}
```

- **What it is.** Markdown files under `/memories`, which the agent reads and edits with one
  `memory` tool (Anthropic's memory tool: `view`, `create`, `str_replace`, `insert`, `delete`,
  `rename`). Each session starts with an index of them, newest first, with each file's
  frontmatter `description`. `access: "read_only"` lets the agent view but not change them; an
  agent used as a tool only views. Memory works the same whoever starts the turn: a person, an
  app, a trigger or a wake.
- **Where it lives.** Postgres, with the Agent: every change is a version naming who made it
  (the manifest version, session, turn and trigger run, or the person or app over the API). A
  fork copies the memories; deleting the Agent deletes them.
- **Managing it.** `GET /v1/agents/{id}/memories`, `GET`, `PUT` (with an optional
  `contentSha256` precondition) and `DELETE /v1/agents/{id}/memories/{path}`, and
  `GET /v1/agents/{id}/memory_versions[/{versionId}]`; `nylorun agents memories ls|cat|put|rm|versions`.
- **Keep secrets out.** The engine tells the agent never to keep secrets, but nothing scans what
  it writes: read an Agent's memory before you share or fork it.
- **Limits.** `memoryBytes`, `memoriesPerAgent`, `memoryIndexLines` and `memoryIndexBytes`
  ([Runtime limits](#runtime-limits)).

`npm run test:t5-exit` checks it on a Compose Tenant: a scheduled Agent writes a memory in one
fire and reads it back in the next, with an upgrade in between.

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

Each turn is one OpenTelemetry trace, derived from the session log: a root span
`invoke_agent <agent>` for the turn, and a child span for every model call (`chat <model>`)
and tool call (`execute_tool <tool>`, a flow's HTTP stage too), plus a marker for each pause
and answer. Egress connections are not in a turn's trace: each is an `agent.egress` event
on its Agent's stream (`GET /v1/agents/{id}/events`), naming the turns running. Attribute names follow the OTel
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
  log event), never content. The content kinds above are each cut at the Tenant's `traceContentBytes` (8 KiB by default, [Runtime limits](#runtime-limits)). A span never carries
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
  message may name any file (protocol 15): the harness learns what the model reads in
  `turn.start.model`, inlines text, and tells the model about a file it does not read; the gate
  refuses a part the model cannot take (`unsupported_input`). A file goes to the model only in the
  turn that brought it;
  later turns name it by a reference line, and the model reads it again with `read_artifact`.
- A custom endpoint behind a model gateway (LiteLLM, for example) can carry headers that are not
  credentials (#493). `settings.headers` go on every call, and `settings.callHeaders` take their
  value per call from the calling Agent: one of its labels (`{ "from": "agent.label", "key": "org" }`),
  its id (`agent.id`) or the session's owner when it is a person (`session.owner`). A source with
  no value sends no header. A Runtime that serves several orgs' Agents can then name each call's
  org, so the gateway attributes and budgets it while the call is made:

  ```json
  { "provider": "custom", "model": "claude", "baseUrl": "https://litellm.internal/v1",
    "auth": { "type": "api_key", "key": "<the gateway's key>" },
    "settings": { "callHeaders": { "x-nylorun-org": { "from": "agent.label", "key": "org" } } } }
  ```

  They are settings, read back by `GET /v1/tenant/model`, never secrets: neither map may set
  `authorization` (the auth sends it), a hop-by-hop or transport header, or `Nylorun-*`, and a
  name appears once across both. A Runtime that serves one org needs none of this: the gateway's
  key already names the org.
- A Compose file you write yourself must run both containers: in a container,
  a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and
  `NYLORUN_GATES_TOKEN`. A proxy between the two must allow an idle request of
  at least 630 s, because the gate answers only when the call has finished.

The gateway is also the Tool Gate. Tool calls that leave the loop cross it, so
the runtime container never holds an MCP credential or calls a tool's server:

- **Remote MCP servers** (`streamable-http` and `sse`): the gateway opens the
  connection, authorizes it from the vault of the session's Agent and runs
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
runs every vault write that touches a secret (writing an Agent's
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

## Runtime limits

How large, how many and how long what crosses the Runtime may be is the Tenant's Runtime
limits: `GET`/`PUT /v1/tenant/limits` (a management key; `admin.settings.limits`,
`nylorun tenant settings limits`). A `PUT` replaces them all: a limit left out takes its
default. No size, count or deadline a Tenant meets is fixed in code; what stays fixed is a
dependency's or a standard's (below the tables).

What a harness must respect, sent in `turn.start.limits`:

| Limit | What it holds | Default | Ceiling |
| --- | --- | --- | --- |
| `recordEntryBytes` | One event's payload, or one effect outcome, in a session's record; a transcript edit fills events up to it | 960 KiB | 960 KiB: S2's 1 MiB record, less room for the event's envelope |
| `modelCallBytes` | A model call's body at the Model Gate | 32 MiB | About 512 MiB: one JavaScript string |
| `modelFileBytes` | One file the Model Gate sends a model | 8 MiB | About 384 MiB: its base64 in one string |
| `toolAnswerBytes` | An MCP or HTTP tool's answer the Tool Gate keeps, and the tool bodies it reads | 8 MiB | 32 MiB: half a 64 MiB Harness API frame |
| `harnessStateBytes` | A custom harness's state per session | 256 KiB | 32 MiB: half a frame |
| `chunkBytes` | One chunked Harness API answer or upload chunk (a skill file's range, an artifact's), and one range of a disk copy | 16 MiB | 48 MiB less 64 KiB: its base64 in one frame |
| `folderEntries` | The files of one folder version a harness writes (our harness's `outputs` folder) | 10,000 files | About 5 million: entries of a manifest read as one string |

What only the Runtime checks:

| Limit | What it holds | Default | Ceiling |
| --- | --- | --- | --- |
| `requestBodyBytes` | A Runtime or Management API request's JSON body (`413` past it) | 1 MiB | About 512 MiB: one string |
| `messageParts` | Parts (text and files) of one user message | 32 | One request body |
| `pageItems` | Items one page of a listing holds (`limit`); a larger `limit` gets this many, and a page with none the route's default (50, or this when lower) | 200 | About 179 million: one response body |
| `exportPageItems` | Calls one page of `GET /v1/tenant/calls/model` holds (default page 200, or this when lower) | 1,000 | One response body |
| `environmentEventItems` | Events one read of an Agent's events returns; `from` reads on | 1,000 | One response body |
| `inlineFileBytes` | One file a message carries inline (AG-UI, A2A); such an endpoint reads one file's base64 and `requestBodyBytes` more | 20 MiB | About 384 MiB: its base64 in one string |
| `a2aWaitMs` | How long a blocking A2A `SendMessage` waits before it answers `WORKING` | 5 min | About 24.8 days: a JavaScript timer |
| `errorExcerptChars` | How much of a failed MCP server's or HTTP tool's answer an error quotes | 2,000 characters | About 160,000: one record entry, escaped |
| `traceContentBytes` | One content attribute of an exported span | 8 KiB | 960 KiB: one record entry |
| `environmentLabels` | Labels on one Agent, checked whenever they are set | 32 | One request body |
| `artifactLabels` | Labels on one artifact, checked when it is uploaded | 32 | One request body |
| `labelKeyChars` | The longest label key (an Agent's or an artifact's) | 63 characters | One request body |
| `labelValueChars` | The longest label value | 256 characters | One request body |
| `environmentSetupCommands` | Setup commands in one manifest's runtime section | 16 | One request body |
| `environmentFiles` | Input file entries in one manifest's runtime section | 16 | One request body |
| `environmentFilesPerEntry` | Files one input file entry by hash names | 1,000 | One request body |
| `environmentSecretSlots` | Secret slots one manifest's runtime section declares | 64 | One request body |
| `manifestDescriptionChars` | An agent manifest's `description` | 1,024 characters | One request body |
| `secretDescriptionChars` | A secret slot's `description` | 500 characters | One request body |
| `secretValueChars` | The value of an `environment_secret` or `environment_variable`, checked when it is written | 8,192 characters | One request body |
| `secretHosts` | Hosts one `environment_secret` may be sent to (`allowedHosts`), in a write or a slot | 32 | One request body |
| `setupCommandChars` | One setup command | 4,096 characters | 43,690: one argument of `/bin/sh -c`, which Linux takes up to 128 KiB (`MAX_ARG_STRLEN`), at 3 UTF-8 bytes a character |
| `setupCommandMs` | The longest `timeout` a setup command may ask for (a command's default is 10 minutes) | 30 min | A JavaScript timer |
| `setupOutputChars` | The end of a failed setup command's output its event keeps | 4,096 characters | One record entry, escaped |
| `setupReasonChars` | The end of that output a failed pod's reason quotes | 500 characters | One record entry, escaped |
| `setupCommandExcerptChars` | The start of the command the reason quotes | 80 characters | One record entry, escaped |
| `diskVersionEntries` | Entries in one version of an Agent's disk (a manifest may set less: `limits.disk.versionEntries`) | 200,000 | About 1.9 million: one disk listing in a Harness API frame |
| `diskVersionBytes` | Bytes of files in one disk version (`limits.disk.versionBytes`) | 10 GiB | A JavaScript number |
| `diskLeaseMs` | How long a disk copy's lease lasts unrenewed (renewed every quarter of it) | 2 min | A JavaScript timer |
| `diskPodWaitMs` | How long a disk copy waits for a pod's engine to connect | 60 s | A JavaScript number |
| `modelRequestMs` | The longest one provider request may take | 600 s | A JavaScript timer |
| `modelIdleMs` | A provider stream's silence before the attempt is retried | 300 s | A JavaScript timer |
| `modelAttempts` | Attempts per model call, the first included | 3 | A JavaScript number |
| `modelRetryDelayMs` | The delay before the second attempt (doubling, with jitter) | 2 s | A JavaScript timer |
| `modelProviderRetries` | Retries the provider SDK makes within one attempt | 2 | A JavaScript number |
| `modelRetryDelayMaxMs` | The longest delay the provider SDK waits before one | 60 s | A JavaScript timer |
| `toolAttempts` | Sends of an MCP or HTTP tool call, across crashes and lost hops, before `tool.interrupted` | 3 | A JavaScript number |
| `httpToolTimeoutMs` | The longest `timeoutMs` an HTTP tool may ask for (a tool's default is 60 s), checked at deploy and at each call | 300 s | A JavaScript timer |
| `mcpSnapshotBytes` | What a session pins of its MCP servers' tools and instructions, which every `turn.start.mcp` carries; a server past it is left out, with a diagnostic | 4 MiB | 16 MiB: a quarter of a Harness API frame |
| `mcpPreviewMs` | How long an MCP tool preview may take | 15 s | A JavaScript timer |
| `mcpMetadataBytes` | The protected-resource metadata document a preview reads | 64 KiB | One string |
| `toolRules` | Rules in the Tenant's tool policy (`PUT /v1/tenant/tool-policy`) | 200 | One request body |
| `toolRuleFieldChars` | A rule's `tool`, `server` or `agent` selector, and a `when` path | 200 characters | One request body |
| `toolRuleTextChars` | A rule's `reason`, and a `matches` expression | 500 characters | One request body |
| `modelBudgets` | Model budgets the Tenant sets (`PUT /v1/tenant/budgets`) | 100 | One request body |
| `flowConcurrency` | Effects one flow turn runs at once; the rest wait their turn | 8 | A JavaScript number |
| `flowMapItems` | Items one map stage fans out to (`map.too-many-items` past it) | 1,000 | A JavaScript number |
| `flowLoopIterations` | Iterations one loop stage runs (`loop.too-many-iterations` past it) | 100 | A JavaScript number |
| `folderFiles` | Files in one agent folder, checked when it is saved (`413 limit_exceeded` past it) | 2,000 | One request body |
| `folderBytes` | Bytes of an agent folder's files together (`413 limit_exceeded` past it) | 50 MiB | A JavaScript number |
| `folderTextFileBytes` | One Markdown or JSON file of an agent folder the compiler reads (`422 folder_invalid` past it) | 1 MiB | One string |
| `sessionQueuedMessages` | Messages one session's queue holds while its turn runs or waits (`429 queue_full` past it) | 100 | A JavaScript number |
| `triggersPerAgent` | Triggers one agent manifest's `runtime.triggers` declares, checked when it is saved | 20 | One request body |
| `triggerMinIntervalMs` | The shortest gap between two runs of one schedule, checked at save over its next fires | 60 s | A JavaScript number; floor 60 s (cron is minute grained) |
| `triggerRunsPerHour` | Runs one Agent's triggers start or queue in any hour; later ones are skipped (`rate_limited`) | 60 | A JavaScript number |
| `triggerJitterPercent` | How far a schedule's fixed offset may move its runs, as a part of its interval | 10 | 50 |
| `triggerJitterMaxMs` | The most that offset may be | 5 min | A JavaScript timer |
| `triggerPromptChars` | One trigger's `prompt` | 8,000 characters | One record entry, escaped |
| `triggerRunRetentionMs` | How long an Agent's runs are kept | 30 days | A JavaScript number; floor 24 h (runs dedupe repeated fires) |
| `wakeMaxAheadMs` | How far ahead `schedule_wake` may book a session's next turn (and at least `triggerMinIntervalMs` ahead) | 30 days | A JavaScript number; a long wait is armed in steps |
| `wakeNoteChars` | The longest note a booked wake carries to its turn | 2,000 characters | One record entry, escaped |
| `webhookBodyBytes` | The largest delivery a webhook endpoint reads, before it verifies it (`413` past it) | 256 KiB | 960 KiB: the payload goes into one record entry |
| `memoryBytes` | The largest memory an Agent keeps, in UTF-8 bytes | 100 KiB | 32 MiB: a memory reaches a harness in one Harness API frame |
| `memoriesPerAgent` | The most memories one Agent holds | 10,000 | A JavaScript number |
| `memoryIndexLines` | The most lines of the memory index a session pins | 200 | A JavaScript number |
| `memoryIndexBytes` | The most UTF-8 bytes of that index | 25 KiB | 16 MiB: it crosses in `turn.start` |

A limit above its ceiling, or under its floor, is `400`, naming the bound and why, and nothing changes.
Each limit is read where it is checked, so a new value holds for the next request, write, call
or turn. Past one, a write into the record is `413 limit_exceeded`
(`details.limit: "recordEntryBytes"`) to an API client, and `limit_exceeded` to a harness; a
turn whose harness reports more fails. A manifest's setup and input files are checked when it
is saved, an Agent's labels whenever they are set, and a secret's value and hosts when it is
written; an Agent made before a limit was lowered keeps running, within the lower limit where one
applies at run time (a setup command's timeout, a disk version).

Model calls and HTTP tools cross the gates, whose hop has its own timeout (host
configuration): a `modelRequestMs` or `httpToolTimeoutMs` longer than it is cut there.

What stays fixed, because a dependency or a standard fixes it: S2's 1 MiB record, the Harness
API's 64 MiB frame, the longest JavaScript string and timer; a token's size (a bearer or a
capability link arrives in a request's headers, which Node caps at `http.maxHeaderSize`), and a
page cursor's, which arrives in a URL; an artifact name's 255 characters and a folder path's
1,024 (`NAME_MAX`, and macOS's `PATH_MAX`, the file systems a workspace lives on), a link
target's 4,096 (Linux's `PATH_MAX`), and a skill file's path within that under its mount
folder; W3C `tracestate`'s 512 characters; a model-facing tool name's 64 characters (what every
provider takes); a `Content-Type`'s 255 (RFC 6838's two 127-character names). An identifier's
grammar is the protocol's, so its length is too: an Agent's id (200), a subject (200), a
manifest's name (64), a credential's name (64), a harness id (63), an application key's id and
an issuer's name (32), an idempotency key (256), the Harness API's ids (512). A custom endpoint's `contextWindow` and `maxTokens`
default to 32,768 and 8,192 (`settings` of `PUT /v1/tenant/model`), and a trusted issuer's
JWKS fetch has its own settings in the identity file (`jwksFetch`).

## Host tuning

The Runtime's own timings, retries, poll intervals and internal sizes are the Host tuning:
one JSON object in `NYLORUN_TUNING`, read once when a process starts. Set only what you
change; everything left out keeps its default, which is the value the Runtime used before it
was a setting. An unknown key, a value of the wrong kind, or one past its ceiling stops the
process with the key's path in the message, such as `NYLORUN_TUNING: tenant.openTimeoutMs: Too
small: expected number to be >=1`.

```sh
NYLORUN_TUNING='{"tenant":{"openTimeoutMs":60000},"sweep":{"intervalMs":2000}}' nylorun start
```

`nylorun start` passes `NYLORUN_TUNING` from its shell to the runtime, gateway and harness
containers. Set it the same for every container of a deployment: each reads the groups it
uses. Core hands a sandbox pod's engine the `harness` and `engine` groups you set, as JSON
of at most 4096 bytes (the most the sandboxes service puts in one of a pod's variables).

Every value in milliseconds (`…Ms`) is a whole number from 1 (0 where the table says so) to
2,147,483,647, the longest delay a Node timer takes. A backoff (`…Retry`, `…Backoff`,
`harness.reconnect`) is `{ "minMs", "maxMs" }`: the first wait, doubled after each failure up
to the longest, with `minMs` at most `maxMs`. Tenant-facing limits are not here: they are the
[Runtime limits](#runtime-limits) and the Tenant's settings.

### Kept as constants

These are fixed by a standard or a dependency, so they are ceilings the tuning is checked
against, not settings: Node's longest timer (2^31 - 1 ms); S3's part sizes (5 MiB to 5 GiB) and
its 1024-byte object key; S2's batch of 1000 records and 1 MiB; the sandboxes service's longest
`?wait=` (30 s) and its 4096-byte pod variables; the
`agent.egress` event's 16 running turns (its contract); W3C Trace Context's 512-character
`tracestate`; the 24-hour floor of a wake's dedupe key (Durable Session Execution §12.3); and
Postgres's 65,535 bind parameters a statement, which bound `postgres.contentBatchRows`. Token
lifetimes are checked against each other: `keys.runTokenTtlSeconds` and
`keys.hostTokenTtlSeconds` at most `keys.tokenTtlMaxSeconds`, `keys.runTokenRenewSeconds`
below the run token's, the host token's longer than `harness.podRenewMs`, and
`execution.advanceDeadlineMs` below `restate.inactivityMs`.

### Keys, the Harness API and the API

| Setting | Default | What it sets |
| --- | --- | --- |
| `keys.bodyBytes` | 1 MiB | The largest request body the keys service reads |
| `keys.timeoutMs` | 30 s | How long core waits for the keys service to answer one call |
| `keys.leafBackdateMs` | 5 min | How far before now an egress leaf certificate is valid from (0 allowed) |
| `keys.leafLifetimeMs` | 1 h | How long a leaf certificate egress-gate presents is valid |
| `keys.caBackdateMs` | 1 h | How far before now the egress CA is valid from (0 allowed) |
| `keys.caLifetimeDays` | 3650 | How many days a new egress CA is valid |
| `keys.tokenTtlMaxSeconds` | 900 | The longest life of a token the Runtime signs (a user's access token, a capability link; a longer `expiresIn` gets this); a key rotation waits it out |
| `keys.runTokenTtlSeconds` | 900 | How long a run token lives |
| `keys.runTokenRenewSeconds` | 300 | A lease re-mints its run token with less than this left |
| `keys.hostTokenTtlSeconds` | 900 | How long a pod's host and egress tokens live |
| `keys.tokenLifetimeSlackSeconds` | 60 | How far a token's `exp` may be past its `iat` beyond its lifetime (0 allowed) |
| `keys.clockToleranceSeconds` | 30 | The clock skew accepted on a token's times, the Runtime's and a trusted issuer's (0 allowed) |
| `harnessApi.joinBodyBytes` | 8 KiB | The largest `host/join` or `host/renew` body |
| `harnessApi.reportBodyBytes` | 64 KiB | The largest setup report a pod's engine posts |
| `harnessApi.closeGraceMs` | 1 s | How long the listener waits for connections to close before it ends them (0 allowed) |
| `harnessApi.offerWaitMs` | 10 s | How long a run offered to the harnesses waits for one to take it |
| `harnessApi.podOfferWaitMs` | 60 s | How long a pod sandbox's segment waits for its engine |
| `harnessApi.loopbackConnectTimeoutMs` | 10 s | How long the Tenant's own harness has to connect to its loopback listener |
| `harnessApi.loopbackBackoff` | 50 ms to 500 ms | How the Tenant's own harness reconnects to it |
| `harnessApi.rolloverSteps` | 50 | A turn ends its segment after this many steps and goes on in a new one |
| `harnessApi.rolloverMs` | 20 min | ...or after this long, well inside the advance deadline |
| `api.agUiHeartbeatMs` | 15 s | How often an AG-UI event stream sends a heartbeat |
| `api.eventStreamKeepaliveMs` | 15 s | How often a session event stream sends a keepalive |
| `host.shutdownGraceMs` | 10 s | How long shutdown waits for requests in progress (0 allowed) |
| `host.readinessTimeoutMs` | 2 s | The bound on one `/ready` pass |
| `host.operateReadyTimeoutMs` | 5 s | How long `nylorun-operate status` waits for the running Host's `/ready` (it reads the container's `NYLORUN_TUNING`) |
| `host.credentialLockPollMs` | 25 ms | How often the project credential store's writer checks its lock... |
| `host.credentialLockAttempts` | 100 | ...and how many times before it gives up |
| `objectStore.partSizeBytes` | 8 MiB | One part of a multipart upload: 5 MiB to 5 GiB |
| `objectStore.attempts` | 3 | Tries of a request answered `5xx` or `429`, or unreachable |
| `objectStore.retryBaseMs` | 100 ms | The wait after the first failed try, doubled after each |
| `objectStore.bucketRetry` | 1 s to 5 s | How core retries creating the bucket while the store starts |
| `objectStore.bucketAttempts` | 10 | Tries at creating the bucket before core logs it unavailable |

### The Tenant, its sweep and Durable Session Execution

| Setting | Default | What it sets |
| --- | --- | --- |
| `tenant.openTimeoutMs` | 30 s | The bound on opening the Tenant; a slower open fails with `open-timeout` |
| `tenant.openRetry` | 1 s to 30 s | Retries of an open that failed outside the Tenant |
| `tenant.ownerLeaseMs` | 30 s | An advance's ownership lease, renewed every third |
| `tenant.busyRetryMinMs` | 25 ms | The shortest retry of an advance whose session another owns |
| `tenant.unavailableRetryMs` | 1 s | How soon an advance no harness took is tried again |
| `tenant.drainTimeoutMs` | 30 s | How long a reset or a drain waits for running turns |
| `tenant.statusTimeoutMs` | 5 s | How long status waits for the execution's stuck invocations |
| `tenant.signingKeyRotationGraceMs` | 60 s | Added to the longest token lifetime before a previous signing key may go (0 allowed) |
| `tenant.retryAfterSeconds` | 5 | The `Retry-After` of a request refused while its Agent is busy or pods are not ready |
| `tenant.seedLeaseMs` | 10 min | How long a pending disk seed of an Agent holds the disk before another process may take it over |
| `tenant.upgradeIdleMs` | 1 min | The longest a pod Agent waiting to start on a new version stays idle before it stops (its own `lifecycle.idle` when shorter) |
| `tenant.upgradeStartMs` | 10 min | How long a pod may take to start on a new version before the Agent goes back to the one it ran |
| `sweep.intervalMs` | 5 s | The delay between sweep passes of the Tenant |
| `sweep.batchSize` | 100 | Rows one sweep query reads at a time |
| `sweep.signalRetentionMs` | 1 h | How long a control signal is kept |
| `sweep.outboxGraceMs` | 30 s | How old an outbox row is before the sweep delivers it (0 allowed) |
| `sweep.orphanScanMs` | 60 s | How often the orphan scan and the stale pod check run |
| `sweep.drainBudgetMs` | 2 s | How long one pass may spend on the outbox, and on orphaned sessions |
| `sweep.armConcurrency` | 16 | Tenant sweeps the Host arms at once when it starts |
| `sweep.outboxAttempts` | 10 | Failed deliveries after which an outbox row is parked |
| `sweep.outboxRetry` | 5 s to 10 min | The wait after an outbox row's failed delivery |
| `sweep.stalePodMs` | 60 s | How long a pod row may go unchanged before the sweep reconciles it |
| `triggers.lateGraceMs` | 2 min | How long after it was due a trigger's fire counts as late, and how overdue an active trigger is before the sweep arms its timer again |
| `triggers.intervalCheckFires` | 100 | How many upcoming fires the save check reads to find a schedule's smallest gap |
| `triggers.webhookToleranceMs` | 5 min | The clock skew a webhook delivery's `webhook-timestamp` may have, either way |
| `execution.advanceDeadlineMs` | 50 min | How long one advance may run before its signal aborts; below `restate.inactivityMs` |
| `execution.advanceGraceMs` | 30 s | How long an aborted advance has to settle before it is abandoned (0 allowed) |
| `execution.stopGraceMs` | 30 s | How long stopping waits for running handlers; keep it at the advance grace (0 allowed) |
| `execution.dedupeRetentionMs` | 24 h | How long a wake's dedupe key merges repeated wakes; at least 24 h |
| `execution.memoryRetryMs` | 50 ms | The in-process execution's first retry of a throwing handler |
| `execution.memoryAttempts` | 5 | The in-process execution's attempts before it reports a handler |
| `restate.sendRetryMs` | 10 s | How long one send through the ingress keeps retrying; under `sweep.outboxGraceMs` |
| `restate.sendBackoff` | 100 ms to 2 s | Its waits |
| `restate.sendTimeoutMs` | 10 s | How long the ingress may take to accept one send |
| `restate.inactivityMs` | 1 h | How long an invocation may run without journal progress; above the longest segment |
| `restate.abortMs` | 1 h | How long after that Restate aborts the attempt |
| `restate.handlerRetry` | 100 ms to 30 s | Retries of a handler that throws |
| `restate.handlerAttempts` | 70 | Its attempts before the invocation is paused |
| `restate.registrationDeadlineMs` | 60 s | How long `start` keeps registering the Worker while Restate comes up |
| `restate.registrationBackoff` | 100 ms to 2 s | Its waits |
| `restate.registrationRequestTimeoutMs` | 30 s | How long one registration request may take |
| `restate.queryTimeoutMs` | 10 s | How long one admin query may take |
| `restate.closeGraceMs` | 2 s | How long stopping lets Restate read answers before it drops connections (0 allowed) |
| `restate.staleSweepIntervals` | 3 | A sweep chain is stale past this many sweep intervals... |
| `restate.staleSweepMinMs` | 60 s | ...and never sooner than this |
| `restate.stuckListDefault` | 100 | Stuck invocations one status lists by default... |
| `restate.stuckListMax` | 1000 | ...and at most |

### Postgres and Durable Streams

| Setting | Default | What it sets |
| --- | --- | --- |
| `postgres.poolSize` | 10 | The Tenant pool's connections |
| `postgres.statementTimeoutMs` | 60 s | The pool's statement timeout (0 turns it off) |
| `postgres.idleInTransactionTimeoutMs` | 60 s | The pool's idle-in-transaction timeout (0 turns it off) |
| `postgres.closeTimeoutSeconds` | 5 | Seconds closing a pool waits for its queries (0 allowed) |
| `postgres.idleTimeoutSeconds` | 30 | Seconds an idle pooled connection stays open |
| `postgres.connectTimeoutSeconds` | 10 | Seconds a connection may take to open |
| `postgres.readPoolSize` | 4 | The read pool's connections (`nylorun-reads`) |
| `postgres.readConnectTimeoutSeconds` | 2 | Seconds a read connection may take to open |
| `postgres.readStatementTimeoutMs` | 2 s | The read pool's statement and idle-in-transaction timeouts |
| `postgres.readCloseTimeoutSeconds` | 2 | Seconds closing the read pool waits (0 allowed) |
| `postgres.controlPollMs` | 5 s | How often the control bus reads back signals it may have missed |
| `postgres.controlWindowSeconds` | 120 | How far back a read-back looks; longer than the poll |
| `postgres.controlRetry` | 100 ms to 5 s | How the control bus listens again after its connection ends |
| `postgres.replicationRetryMs` | 5 s | How soon the stream relay and trace projector try again to take their slot |
| `postgres.replicationPoolSize` | 2 | The replication service's connections (the stream relay, the trace projector) |
| `postgres.contentBatchRows` | 1000 | Rows one statement writes or looks up when a folder version or a manifest names many files; at most 16,383 (Postgres's 65,535 parameters, four a row) |
| `streams.retry` | 100 ms to 2 s | Session stream reads, basin deletions and repairs |
| `streams.basinRetryMaxMs` | 5 s | The longest wait between two basin repairs |
| `streams.basinRepairCooldownMs` | 1 s | A repair this soon after the last waits for the next failure (0 allowed) |
| `streams.basinLogEveryFailures` | 10 | A repair that keeps failing is logged on its first failure and every this many after |
| `streams.feedCheckMs` | 30 s | How often every session stream is checked against its session |
| `streams.retireGraceMs` | 60 s | How long a retired basin stays for readers that have not moved (0 allowed) |
| `streams.retireAttempts` | 5 | Attempts to delete a retired basin before the next open tries again |
| `streams.probeTimeoutMs` | 2 s | How long a streams probe waits |
| `streams.relayRetry` | 50 ms to 2 s | The stream relay's retries of a failed append |
| `streams.relayBatchRecords` | 500 | Records per relay append, at most 1000 (S2) |
| `streams.relayBatchBytes` | 768 KiB | Bytes per relay append, at most 1 MiB (S2) |
| `streams.relayReconcileConcurrency` | 8 | Sessions the relay reconciles at once |
| `streams.relayHeadsPage` | 500 | Session heads the relay reads a page at a time |
| `streams.s2Retry` | 100 ms to 2 s | S2 reads retried |
| `streams.s2ConflictAttempts` | 6 | Attempts of an append that loses a `transaction_conflict` race |
| `streams.s2ConflictRetryMs` | 25 ms | Its first wait, doubled, with jitter |
| `streams.s2BasinRetryMs` | 500 ms | The first wait while a basin's deletion finishes |
| `streams.s2BasinDeletionWaitMs` | 2 min | How long creating a basin waits for its deletion to finish |

### The gateway and egress-gate

| Setting | Default | What it sets |
| --- | --- | --- |
| `gates.clientTimeoutMs` | 630 s | How long the loop's connection to the gate may stay silent; above the 600 s provider timeout |
| `gates.shortTimeoutMs` | 2 s | How long a cancel or a close may take |
| `gates.keepAliveMs` | 30 s | TCP keepalive of the loop's connections to the gate |
| `gates.requestTimeoutMs` | 660 s | The gate listener's request timeout; above `gates.clientTimeoutMs` |
| `gates.probeTimeoutMs` | 2 s | How long the gate's database probe may take |
| `gates.mcpIdleMs` | 15 min | How long the gate's MCP connections may sit unused |
| `gates.errorMessageChars` | 2000 | How much of an MCP connection's unexpected error the loop is told |
| `gates.mcpSweepMinMs` | 1 s | Idle MCP connections are swept every `gates.mcpIdleMs`, at least this often... |
| `gates.mcpSweepMaxMs` | 60 s | ...and at most this long apart |
| `gates.toolCrossingTtlMs` | 24 h | How long a settled tool call crossing is kept |
| `gates.toolCrossingPruneMs` | 1 h | How often old crossings are pruned |
| `gates.drainMs` | 10 s | How long the gate drains calls in progress when it stops (0 allowed) |
| `gates.drainPollMs` | 50 ms | How often it checks meanwhile |
| `gates.inflightTtlMs` | 30 min | How long a settled model call is kept for a retry to join |
| `gates.inflightMax` | 10,000 | How many are kept, the oldest settled dropped first |
| `egress.maxTunnelsPerSandbox` | 64 | Tunnels one sandbox may hold open at once |
| `egress.idleMs` | 5 min | A tunnel with no traffic for this long is closed |
| `egress.cacheMs` | 5 s | How long a sandbox's epoch and allowlist are reused (0 allowed) |
| `egress.cacheEntries` | 4096 | How many sandboxes' are kept |
| `egress.connectTimeoutMs` | 10 s | How long the gate waits for the upstream connection |
| `egress.headersTimeoutMs` | 10 s | The proxy listener's header timeout |
| `egress.requestTimeoutMs` | 15 s | The proxy listener's request timeout |
| `egress.credentialsHeadersTimeoutMs` | 60 s | The header timeout of a tunnel whose TLS the gate terminates for a bound secret |
| `egress.credentialsMaxSockets` | 8 | The upstream sockets one such tunnel opens at once |
| `credentialProvider.cacheMs` | 15 s | How long an Agent's answer from the [credential provider](#an-outside-credential-provider) (its hosts, or its variables) is reused (0 allowed) |
| `credentialProvider.retryMs` | 5 s | How long a failed answer (nothing) is reused before the provider is asked again (0 allowed) |
| `credentialProvider.timeoutMs` | 3 s | How long one `hosts` or `environment` call to the provider may take |
| `credentialProvider.cacheEntries` | 4096 | How many Agents' answers are kept |

### Sandbox pods, harnesses and traces

| Setting | Default | What it sets |
| --- | --- | --- |
| `pods.readyDeadlineMs` | 5 min | How long a pod may take to be ready before its start fails |
| `pods.pollMs` | 2 s | How often a pod that is changing is checked |
| `pods.unreachableRetryMs` | 5 s | How soon a pod is checked again when the sandboxes service did not answer |
| `pods.readyCacheMs` | 5 s | How long the sandboxes service's readiness answer is reused (0 allowed) |
| `pods.reconcileRetryMs` | 5 s | How soon a reconcile whose apply failed runs again |
| `pods.requestTimeoutMs` | 20 s | One request to the sandboxes service |
| `pods.readyProbeTimeoutMs` | 3 s | Its `/ready` probe |
| `pods.waitMs` | 30 s | How long a `?wait=` request waits; the service takes 30 s at most |
| `pods.waitSlackMs` | 10 s | Added to a `?wait=` request's timeout for its answer to arrive (0 allowed) |
| `pods.enginePollMs` | 250 ms | How often a disk copy or a seed checks whether a pod's engine has connected |
| `pods.memoryFloorMiB` | 128 | The least memory a sandbox gets; a manifest or a Tenant limit asking less rounds up |
| `harness.pingMs` | 30 s | How often core pings a harness's WebSocket |
| `harness.silenceMs` | 90 s | How long either end may hear nothing before it drops the connection |
| `harness.reconnect` | 500 ms to 10 s | How a harness reconnects to core's Harness API, with jitter |
| `harness.handshakeTimeoutMs` | 10 s | How long the WebSocket handshake may take |
| `harness.reconnectStopMs` | 5 s | How long a lost connection's runs have to wind down (0 allowed) |
| `harness.stopMs` | 10 s | How long stopping a harness container waits for its runs (0 allowed) |
| `harness.podStopMs` | 7 s | ...and a pod's engine, inside the pod's stop grace (0 allowed) |
| `harness.runTokensMax` | 10,000 | The sessions whose last run token a harness keeps |
| `harness.mcpSweepMs` | 60 s | How often a harness closes idle MCP connections |
| `harness.mcpIdleMs` | 15 min | How long one may sit unused |
| `harness.mcpListPages` | 100 | The most `tools/list` pages one MCP server's listing reads (discovery and previews); later pages are left out |
| `harness.mcpDiagnosticChars` | 500 | How much of an MCP connection's error its discovery diagnostic keeps |
| `harness.helperCommandTimeoutMs` | 60 s | How long one of the Runtime's own commands in a sandbox may take (folders, skill mounts, tool helpers) |
| `harness.helperCommandExcerptChars` | 120 | How much of such a command a failure quotes |
| `harness.scrubMinChars` | 8 | The shortest credential value scrubbed from what a tool, command or model returns; every process that scrubs reads it |
| `harness.execCommandChars` | 500 | How much of a command an `environment.exec` event keeps |
| `harness.commandStreamBytes` | 4 MiB | The local sandbox backend: what it keeps of each of a command's output streams |
| `harness.podRenewMs` | 5 min | How often a pod's engine renews its host and egress tokens |
| `harness.podRenewEarlyMs` | 60 s | It renews before a call when its token expires sooner than this (0 allowed) |
| `harness.podJoinTimeoutMs` | 15 s | How long `host/join` and `host/renew` may take |
| `harness.podRequestTimeoutMs` | 5 min | How long another host call (setup, files) may take |
| `harness.networkPolicyTimeoutMs` | 120 s | How long a pod's engine waits for its NetworkPolicy before it starts |
| `harness.networkProbeMs` | 1 s | One probe of an address the policy blocks |
| `harness.networkPauseMs` | 250 ms | The pause after a probe that connected (0 allowed) |
| `harness.networkConfirmations` | 3 | Failed probes in a row that prove an address blocked |
| `harness.setupRetryPollMs` | 5 s | How often a failed setup of an Agent's pod asks whether to run again |
| `harness.setupAfterSeedPollMs` | 1 s | How often a fork's setup asks whether its disk version is written |
| `harness.setupReportTailChars` | 4096 | The characters of a failed setup command's output its report keeps |
| `traces.timeoutMs` | 10 s | How long one OTLP request may take |
| `traces.retries` | 3 | Tries after the first, for a `429`, a `5xx` or a lost connection (0 allowed) |
| `traces.backoffMs` | 500 ms | The wait before the first retry, doubled after each |
| `traces.batchSpans` | 512 | Spans per post |
| `traces.batchDelayMs` | 2 s | How long a span waits for its batch to fill |
| `traces.queuedSpansMax` | 8192 | Spans that may wait while a post is out; past it they are dropped |
| `traces.turnCacheSize` | 1024 | Turns whose trace the projector keeps |
| `traces.retryMs` | 1 s | How soon the projector reads again when Postgres did not answer |

### Our engine

`engine` holds the options of our engine (`createHarness` in `@nylorun/harness`), which a harness
container, a pod's engine and the Tenant's own harness pass to it. Nothing is set by default:
each option left out is the engine's own default, listed with `createHarness` in
[runtime/harness/src/CONTEXT.md](../runtime/harness/src/CONTEXT.md).

| Setting | Engine default | What it sets |
| --- | --- | --- |
| `engine.transcriptCacheMb` | 256 | The transcript cache's budget, in MiB |
| `engine.artifactPageBytes` | 32 KiB | The most bytes one `read_artifact` page holds |
| `engine.skillReadBytes` | 10 MiB | The most bytes of one skill file read into the model's context |
| `engine.leaseRetryMs` | 100 ms | How soon a failed `lease` request is sent again |
| `engine.resendDelaysMs` | `[1000, 2000, 4000]` | The waits before each resend of a tool call whose gate hop lost its answer; the last repeats |
| `engine.partialOutputChars` | 4000 | How much of a failed agent-as-tool's last output its parent sees |
| `engine.flowValueChars` | 80 | How much of a value a flow's failure message quotes |
| `engine.compaction` | `DEFAULT_COMPACTION_CONFIG` | `keepTokens` (20,000), `keepShare` (0.3), `reserveTokens` (8,192), `maxReserveTokens` (16,384), `maxReserveShare` (0.25), `clipChars` (2,000), `summaryOverheadTokens` (1,024), `imageTokens` (1,600), `fileBytesPerToken` (8), `fileTokensMax` (100,000), `minChunkTokens` (1,000), `minSummaryTokens` (256), `summaryShare` (0.8), `charsPerToken` (4) |
| `engine.sandboxTools` | `DEFAULT_SANDBOX_TOOL_LIMITS` | The `bash` timeouts and output, `read`, `grep` and `glob` counts |
| `engine.mcpTools` | `DEFAULT_MCP_TOOL_CONFIG` | When MCP tools are deferred, and `tool_search`'s limits |
| `engine.toolResults` | `DEFAULT_TOOL_RESULT_CONFIG` | Inline caps, previews (the smallest a stub keeps, `minPreviewBytes`, 64) and the step budget of tool results |
| `engine.outputs` | `DEFAULT_OUTPUTS_CONFIG` | The outputs folder (`dir`, absolute) and the most bytes one save stores |

### The CLI

`nylorun`'s own waits are its tuning, one JSON object in `NYLORUN_CLI_TUNING` in the shell that
runs it, read each time a value is used; what is left out keeps its default (the value it used
before), and an unknown key or a value that is not a positive whole number stops the command.

```sh
NYLORUN_CLI_TUNING='{"stack":{"healthWaitMs":120000},"compose":{"healthchecks":{"harness":{"retries":180}}}}' nylorun start
```

| Group | Settings (defaults) |
| --- | --- |
| `stack` | `probeTimeoutMs` (3 s), `healthWaitMs` and `tenantWaitMs` (60 s), `pollMs` (500 ms), `operateEveryPolls` (10), `composeWaitSeconds` (300) and `studioWaitSeconds` (120) for `docker compose up --wait-timeout`, `loginWaitMs` (15 s), `loginRequestMs` (5 s), `keyCheckMs` (10 s), the key file's `lockWaitMs` (30 s), `lockStaleMs` (60 s) and `lockPollMs` (100 ms), `portAttempts` (20), `seedRequestMs` (15 s) |
| `compose` | `walKeepSizeMb` (4096: Postgres's `max_slot_wal_keep_size`), and `healthchecks.<service>` `{ intervalSeconds, timeoutSeconds, retries }` for `postgres`, `restate`, `rustfs` and `studio` (2, 5, 30), `gateway` and `runtime` (2, 5, 60), `harness` (2, 5, 90), `sandboxes` (5, 5, 24) |
| `sandbox` | `kubectlTimeoutMs` (300 s) and `kubectlMarginMs` (20 s), `manifestDownloadMs` (60 s), `crdWaitSeconds` (60), `rolloutWaitSeconds` (180), `tokenWaitMs` (60 s), `pollMs` (1 s), `composeWaitSeconds` (120), `infoRequestMs` (5 s), `probeWgetSeconds` (3), `probeExecMs` (20 s), `probeReadySeconds` (180), `policyTimeoutMs` (30 s), `prepullMs` (300 s), `prepullPollMs` (2 s), the probe pods' `probeGraceSeconds` (1, 0 allowed), `probeCpu` (`200m`) and `probeMemory` (`64Mi`) |

## MCP servers and HTTP tools

An agent names its remote MCP servers and HTTP tools by URL, and its manifest never holds a
secret: at most a slot, its runtime section's `secrets` entry bound to that URL, which a server's
or HTTP tool's `credential` names. Whoever makes an Agent decides, per URL, how its sessions
reach each one, with a credential in the Agent's vault. The same manifest can then use a key on
a laptop and an MCP gateway in production. For each server:

1. **Write a credential** for its URL into the Agent ([Credentials](#credentials)), or none
   for a public server.
2. **Preview its tools** with that credential ([Previewing a server](#previewing-a-server)).
3. **Set its tools** in the agent's manifest: which are enabled and which are deferred
   ([Tools, results and errors](#tools-results-and-errors)). Which calls wait for a person is the
   Tenant's tool policy ([Tool policy](#tool-policy)).
4. **Open sessions on the Agent**: `agent` when your app server opens one. Check first that it
   covers its manifest ([Checking an agent's credentials](#checking-an-agents-credentials)).

An agent with only remote MCP servers and HTTP tools needs no sandbox: save its manifest with no
runtime section (or kind `none`), and its Agents have a vault and no compute. Upgrading from
protocol 15, which had Environments: [MIGRATION.md](./MIGRATION.md#agents-from-one-manifest-protocol-16-harness-api-5);
from protocol 10, which had user and installation vaults:
[MIGRATION.md](./MIGRATION.md#environments-replace-sandboxes-and-vaults-protocol-11-a-fresh-start);
from protocol 9, which had an MCP OAuth connect and a credential resolver:
[MIGRATION.md](./MIGRATION.md#mcp-credentials-from-vaults-only-protocol-10).

### Credentials

A session's MCP and HTTP tool credentials come from the vault of the session's Agent: the slot
a server or HTTP tool names (`credential`), else the credential bound to the URL the agent names.
Each Agent has exactly one vault, created and deleted with it; there is no vault shared between
Agents, so a key many Agents use is written into each (a fork copies the ones its manifest
declares).

Secrets are written on the Runtime API, by name: `PUT /v1/agents/{id}/secrets/{name}`
(`client.agents.secrets.put` in `@nylorun/agents`), with an application key, or acting for a
person with `agents:write`. `GET .../secrets` lists names, types and bindings, and
`DELETE .../secrets/{name}` removes one. When the manifest declares the slot, send only
`{ value }` (or `{ headers }`): the type and binding below come from the slot. A credential for a
tool is bound to one URL, the one the manifest names, and its name is a label (1–64 letters,
digits, `.`, `_` and `-`). It is one of three types:

| `type` | Body | Sends |
| --- | --- | --- |
| `bearer` | `{ type: "bearer", url, value }` | `Authorization: Bearer <value>` |
| `headers` | `{ type: "headers", url, headers: { … } }` | Every header of the map: an `x-api-key`, two keys at once (Datadog's API and application keys), or a scheme other than `Bearer` |
| `workload` | `{ type: "workload", url, via }` | `Authorization: Bearer <the Runtime's workload token>`, to `via` only ([The workload token](#the-workload-token)). It holds no value |

Either kind may add:

- **`via`**: where the requests go instead of `url`, such as a gateway. The manifest's URL still
  picks the credential, and tool names and diagnostics keep the manifest's server name. It is an
  `https` URL (plain `http` only to a loopback host) with no userinfo, query string or fragment,
  and the Host's address policy applies to it.
- **`toolPrefix`** (with `via`; Host feature `gateway-credentials`): what the gateway puts before
  each tool name it lists, such as LiteLLM's `github-`. The Runtime takes it off, so tool names
  (`github__create_issue`), a manifest's `tools` settings and tool policy rules name the server's
  own tools whether or not a gateway is in between, and calls each tool by the name the gateway
  listed. A listed tool that lacks the prefix keeps its name, and the server's discovery diagnostic
  names it. It is the installation's routing, so it goes on the Agent's secret only: a manifest's
  secret slot cannot name it, and a slot's value write (`{ "headers": { … }, "toolPrefix": "github-" }`)
  adds it to a slot with `via`.
- **`identity: { header }`**: a header that carries the session owner's subject, for a gateway
  that keeps each person's accounts ([Reaching a person's accounts](#reaching-a-persons-accounts)).

Write one in Studio, with `@nylorun/agents`, with `npx nylorun agents secrets put`, or with
`PUT /v1/agents/{id}/secrets/{name}`:

```ts
await client.agents.secrets.put("projects/acme", "tickets", {
  type: "headers",
  url: "https://mcp.tickets.example/mcp",
  headers: { "x-api-key": process.env.TICKETS_KEY!, "x-account-id": process.env.TICKETS_ACCOUNT! },
});
```

- Values are sealed with the vault key and write-only. No answer, event or log line holds one: a
  credential is listed with its header names, `via`, `toolPrefix` and identity header only.
- A `PUT` to an existing name replaces the credential: its value, URL, `via`, `toolPrefix` and
  identity header together. The next request uses the new value.
- One URL has at most one credential per Agent: a second `bearer` or `headers` credential
  for the same URL is `409 credential_conflict` at the write.
- The transport's own headers (`Content-Type`, `Accept`, `Mcp-Session-Id`, …), `Idempotency-Key`
  and `Nylorun-*` are refused. A credential header replaces a manifest header of the same name.
- An MCP server with no credential in the Agent's vault is called without one: a server that
  needs one answers `401`, and `mcp.discovered` reports it for that session. An HTTP tool that
  names a `credential` the vault lacks fails with `http.credential`, and is not sent.

### Reaching a person's accounts

Nylorun holds no OAuth client, refreshes no token and asks no credential resolver (protocol 10).
A tool call acts either as the installation or as a person. What to add depends on what the
server takes:

| The server takes | The credential | In |
| --- | --- | --- |
| A key the person made, such as a personal access token (GitHub, Linear, Supabase) | `bearer` or `headers` | The person's own Agent |
| Only the person's sign-in, with OAuth (Notion, Slack, Gmail) | A gateway credential: the MCP gateway's key, `via` and an identity header | Each Agent whose sessions use the server |
| A client id and secret, exchanged for a short-lived token (MongoDB Atlas, Google service accounts) | A gateway credential | Each Agent whose sessions use the server |

In a survey of the 50 most used remote MCP servers (2026-10-07), half, and 7 of the top 10, took
only a person's sign-in, so an MCP gateway is how most installations reach a person's tools.

#### A person's own key

Give the person an Agent of their own, with the owner guard set to them, write their key into it
(the slot its manifest declares for the server's URL, here `linear`), and open their sessions on
it:

```ts
await client.agents.put("users/alice/triage", { manifest: "triage", owner: "alice" });
await client.agents.secrets.put("users/alice/triage", "linear", { value: process.env.ALICE_LINEAR_KEY! });
await client.createSession({ id: "alice-inbox", agent: "users/alice/triage", ownerUserId: "alice" });
```

A key acts as whoever made it: put a person's own token only in an Agent that only their
sessions may run on (`owner`), and a key that acts for the organization in the Agents your app
gives everyone.

#### A gateway credential

An MCP gateway holds each person's sign-ins, refreshes their tokens, and asks a person who has not
connected an account yet to do so (most gateways return a link in the tool result, or through
MCP's URL elicitation, and the model passes it on). The installation reaches the MCP gateway
with one key, and the Runtime names the person in a header:

```ts
await client.agents.secrets.put("users/u_7c41/web", "notion", {
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
  that changes its `via` must send a value too, so whoever can write an Agent cannot
  redirect a key they do not hold. Give it only the scopes your agents need, and rotate it like
  any other key (write it again into each Agent that holds it).
- Every tool argument and result passes through the MCP gateway.
- A `401` from the MCP gateway is `credential_rejected` to the model, and is not retried. So is an
  answer in which the MCP gateway reports that the server behind it answered `401`, even when the
  MCP gateway itself answers `200`. LiteLLM does this for a token the provider revoked: a
  `tools/list` with no tools and `"auth_required"` for the server in
  `_meta["litellm.ai/server_outcomes"]`, and a failed tool call whose text is `HTTPStatusError:
  Client error '401 Unauthorized'`. The server's discovery is then `failed`, so your product can
  ask the person to connect again. A server reached without `via` is never read this way.

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

**LiteLLM** (self-hosted, MIT; 1.106.0). Its per-server endpoint `/mcp/<server>` lists every tool
as `<server>-<tool>`, and no setting turns that off, so give the prefix. A token the provider
revoked comes back as HTTP 200 with `auth_required` in `_meta`, which the Runtime reports as
`credential_rejected` (above). Its custom auth decides which header names the person.

```json
{ "type": "headers", "url": "https://api.githubcopilot.com/mcp/", "via": "https://litellm.internal/mcp/github",
  "toolPrefix": "github-", "headers": { "Authorization": "Bearer <LiteLLM key>" },
  "identity": { "header": "<its user header>" } }
```

**Nylorun Cloud** (hosted; untested). Its MCP gateway takes a key per installation and the
identity header, and adds the person's credential from their connections. It is one gateway
among these: nothing in the open-source Runtime is specific to it.

```json
{ "type": "headers", "url": "<the server's own URL>", "via": "<the Cloud MCP gateway's URL>",
  "headers": { "x-api-key": "<installation key>" }, "identity": { "header": "<its user header>" } }
```

#### The workload token

A platform that runs Runtimes can give each installation a short-lived token and rotate it through
a file, so its gateways trust the workload instead of a stored key (#496). Vercel's OIDC token
(`VERCEL_OIDC_TOKEN_FILE`) is one. Point the Runtime at it:

| Variable | Value |
| --- | --- |
| `NYLORUN_WORKLOAD_TOKEN_FILE` | The token's file. The Runtime reads it at each use and keeps nothing, so a rotation applies to the next request with no restart. A missing, unreadable or empty file fails the request with a message naming the variable; nothing is sent without the token |
| `NYLORUN_WORKLOAD_TOKEN_ORIGINS` | The comma-separated origins the token may go to, such as `https://connections.example.com`: each `https` (`http` only to a loopback host) |

Set both on every container that makes the calls: in the local stack, the `gateway` container,
and the `runtime` container of a Runtime without the gates service. Mount the file read-only.

- **Tools.** A `workload` credential (`{ type: "workload", url, via, identity?, toolPrefix? }`)
  sends `Authorization: Bearer <token>` and, as any credential, the identity header to `via`. Its
  writer chooses `via`, so the Runtime sends the token only when `via`'s origin is in
  `NYLORUN_WORKLOAD_TOKEN_ORIGINS`, checked at each request; otherwise the server is `refused` at
  discovery. A `401` from the gateway is `credential_rejected`, with `gateway` naming its origin,
  so an expired or unrotated token shows. The gateway's report of an upstream `401` and its tool
  prefix apply as for any credential. It cannot fill a manifest's secret slot: write it to the
  Agent by URL, and a fork does not copy it.
- **The model.** `PUT /v1/tenant/model` with `{ "provider": "custom", "baseUrl": "…", "auth": { "type": "workload" } }`
  sends the token as the custom endpoint's bearer, read at each call. Only a custom endpoint takes
  it: its `baseUrl` is the operator's, so no origin list applies.

#### The Host's identity (Google)

A Runtime on Google Cloud can call Gemini on Agent Platform (Vertex AI) with its own identity, the
attached service account, instead of a stored API key ([ADR-71](https://github.com/nylorun/factory/blob/main/decisions/engine/2026-10-21-model-host-identity.md)).
That suits an organization whose policy forbids API keys. Lend it, as the operator, on the process
that runs the gates:

| Variable | Value |
| --- | --- |
| `NYLORUN_MODEL_HOST_IDENTITY` | The comma-separated providers whose models may use the Host's identity. Only `google-vertex` today. Unset: none, and a `host_identity` credential is refused |

`nylorun start` passes it from its shell to the `gateway` container. Then set the model, with no
key:

```sh
NYLORUN_MODEL_HOST_IDENTITY=google-vertex nylorun start
nylorun tenant models set --provider google-vertex --model gemini-4-argon \
  --host-identity --project <project id> --location global
```

That is `PUT /v1/tenant/model` with `"auth": { "type": "host_identity", "project": "…",
"location": "…" }`.

- **What it keeps.** No secret: only the project the calls go to and bill, and their location.
- **How it calls.** At each call, Google's client library finds the Host's Application Default
  Credentials: the file in `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's application default
  credentials, or, on Google Cloud, the metadata server's service account. Grant that account
  `roles/aiplatform.user` in the project. It is the only credential the model gate finds outside
  the vault.
- **Who may use it.** Every Tenant on the Host. Lend it only on a Host that serves one
  organization.
- **When it's taken away.** Unset the variable and restart: each call on a stored `host_identity`
  model fails with `auth`, naming the variable.
- The token stays in the process that makes the call. It never reaches a sandbox (the sandbox's
  environment has no `NYLORUN_*` variable), the model, an event or a log, and is scrubbed from what
  a server or the provider echoes, like any credential value.

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
Atlas and Google service accounts, PayPal). An Agent's credential is a static header and the Runtime
refreshes nothing, so reach these through a gateway or a proxy that does the exchange, with a
`via` credential as above.

### Checking an agent's credentials

Before you open sessions, ask what a session on an Agent would send, with a management key:

```ts
const coverage = await admin.coverage({ agentId: "projects/acme" });
for (const entry of coverage.entries) console.log(entry.status, entry.name, entry.message);
```

`POST /v1/tenant/credential-coverage` with `{ agentId }` (Host feature `credential-coverage`)
lists every remote MCP server and every HTTP tool `credential` the version of the manifest the
Agent runs declares: its own, its subagents' and a flow's stages and agents. For each one, the
Agent's vault decides as a call would (the slot it names, else the same URL comparison):

| `status` | A session would |
| --- | --- |
| `covered` | Send `credential` (its Agent, its name and its `via`) |
| `missing` | Call an MCP server without a credential, which only a public server accepts, or fail an HTTP tool with `http.credential` |

`complete` is true when every entry is `covered`. Nothing reads a secret or calls a server.
Studio's **New session** runs this check for the Agent it picks.

### Previewing a server

```sh
nylorun tenant mcp inspect https://mcp.linear.app/mcp --server linear --agent projects/acme
```

`nylorun tenant mcp inspect <url> --agent <id>` connects with that Agent's credential for
the URL (its headers and `via`, never an identity header), or with none when you name no
Agent, lists the server's tools within 15 s, and calls none. So do
`admin.mcp.preview({ url, agentId })`, `POST /v1/tenant/mcp/preview` with
`{ url, agentId }` and **Preview tools** in Studio. It shows each tool's model name (as our harness names it for a manifest
naming the server `--server`; a custom harness names its own), its hints and the size of its
input schema, the tools renamed for the model, and the server's instructions. A server that answers `401` needs a credential: the preview says so and shows the
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
  window, our harness leaves them out of the model's tool list and gives it `tool_search` and
  `tool_call`, with a note naming each server. `deferred: true` or `false` on a tool, on `"*"` or
  on the server decides instead (a hint the session's harness follows). Our harness makes the
  choice once per session, so the tool list is the same at every step, even after the Tenant's
  model changes.
- **Names.** Our harness gives the model a tool as `server__tool`, with characters outside
  `[A-Za-z0-9_-]` replaced by `_` (a dotted `issues.create` is `github__issues_create`). The
  server is still called by its own name, and the tool policy, approvals and the tool call log
  name it by `server` and its own name.
- **Results.** Our harness stores a result past 32 KiB, and every image, audio or file part of
  one, as a file artifact of the session, and the model gets a preview and the artifact's id. It
  reads on with `read_artifact`, 32 KiB a call. These artifacts count toward the Tenant's artifact
  limits (`PUT /v1/tenant/artifacts`). An answer past the Runtime limit `toolAnswerBytes`
  (8 MiB by default, [Runtime limits](#runtime-limits)) is not kept, and the Runtime records no
  outcome past `recordEntryBytes`.
- **Secrets.** A credential value a server echoes back is replaced with `[redacted]` before the
  model, an event or the Tool Gate's record sees it.

When a call fails, the model gets a failed tool result with a `code` and a `message` (and, for
an MCP call, `retryable`), and `tool.completed`'s `error` records the same:

| Code | When | Retryable |
| --- | --- | --- |
| `credential_rejected` | The MCP server, the MCP gateway or the HTTP tool's service answered `401`, or the MCP gateway reported that the server behind it did | No, and never retried: rotate the key, or have the person connect again at the MCP gateway |
| `mcp.unreachable` | The call was never sent: a refused address, DNS, a refused connection, TLS | Yes |
| `mcp.forbidden` | `403` | No |
| `mcp.error` | A JSON-RPC error, with its code in the message | No |
| `mcp.status` | Another HTTP error status | For `408`, `429`, `502`, `503` and `504` |
| `mcp.lost` | Sent, and the answer lost: the tool may have run, and the model decides whether to call it again | Yes |
| `mcp.too-large` | An answer past the Runtime limit `toolAnswerBytes` (8 MiB by default) | No |

A tool's own error result (`isError`) is `mcp.tool`. `tool_call` answers `tool.unknown` for a
name no deferred tool has, and `tool.invalid-arguments` for arguments that do not match the
tool's input schema, without running it. An HTTP tool's other failures are `http.status`,
`http.timeout`, `http.refused`, `http.unreachable`, `http.lost`, `http.credential` and
`http.too-large`. A `credential_rejected` error names the server (or the HTTP tool's
`credential`), never a value.

### Tool policy

Which MCP and HTTP tool calls run, wait for a person, or are refused is the Tenant's tool
policy: yours to set, with a management key, for every agent and every harness at once.

<!-- doc-test: tool-policy -->
```bash
curl -X PUT "$NYLORUN_RUNTIME_URL/v1/tenant/tool-policy" \
  -H "Authorization: Bearer $NYLORUN_MANAGEMENT_KEY" -H "Content-Type: application/json" \
  -d '{"rules": [
        {"effect": "ask", "server": "github", "tool": "create_issue", "reason": "A person files issues"},
        {"effect": "deny", "kind": "http", "tool": "refund_*", "when": {"amount": {"gt": 10000}}},
        {"effect": "ask", "agent": "triage", "server": "github"}
      ]}'
```

`admin.toolPolicy.get()` and `.put({ rules })` do the same from `@nylorun/admin`. A rule matches
a call when every selector it sets matches: `tool` (the tool's own name: an MCP tool's name on
its server, such as `create_issue`, or an HTTP tool's declared name; `*` matches any run of
characters), `server` (an MCP server's name), `kind` (`mcp` or `http`), `agent` (the agent that
calls it: its manifest's name, or a subagent's or a flow agent's id), and `when` (fields of the input by dotted path, each tested with `equals`, `in`, `gt`,
`gte`, `lt`, `lte` or `matches`). The strictest rule that matches decides, whatever their order;
a call no rule matches runs.

Name an MCP tool by `server` and `tool`, never by the name the model knows it by: a harness
chooses that name, and the policy never matches it. A `tool` with `__` in it (a model-facing
`server__tool` name) is refused with `400`. A policy stored before protocol 15 with such a rule
fails closed: every MCP and HTTP tool call is denied with a reason naming the rule, and
`GET /v1/tenant/tool-policy` answers `409 request_rejected`, until you `PUT` the policy again
with `{"server": "github", "tool": "create_issue"}` in place of `{"tool": "github__create_issue"}`.

- **`deny`**: the call is never sent; the model gets `tool.denied`, with the rule's `reason`.
- **`ask`**: the turn pauses with the call's tool (an MCP call's `server` and `tool`, shown as
  `server / tool`), input and reason (`turn.paused`, and `GET /v1/sessions/{id}/calls/tool`
  shows it `held`). An `approve` command on the session sends
  that exact call; a refusal fails it to the model as `tool.denied`, unsent. Nothing holds a
  process while it waits: an approval can come a day later, or after a Runtime restart. Studio
  shows an approval card on the session.
- **`allow`**: the call runs.

The Runtime decides as it journals the call, before anything is sent, and the gateway runs only
a call the journal holds running, so no harness can skip the policy. A policy that cannot be read
refuses every call. Sandbox tools never cross the gateway: control their network side with the
runtime section's egress rules. A manifest no longer sets `approval`; a session pinned to one saved
with `approval: "always"` keeps it as an ask.

## Credentials for skills

A skill that runs a CLI (`gh`, `glab`, `aws`, `curl`) on a pod Agent authenticates with
a credential whose value never enters the sandbox. Two more secret types live in the same
Agent vault as MCP credentials; for both, the secret's name is the variable's name
(`PUT /v1/agents/{id}/secrets/GH_TOKEN`), and a skill names the ones it reads in its `secrets`
(in an agent folder, `AGENT.md`'s skills block: `skills: { github-issues: { secrets: [GH_TOKEN] } }`;
`secrets: [GH_TOKEN]` in a `SKILL.md`'s frontmatter is deprecated, still read with a warning, and
`nylorun migrate folder` moves it), which must be slots of these types in the manifest's runtime
section:

- **`environment_secret`** `{ type, value, allowedHosts, inject? }`: every command sees
  `$<name>` set to `nylorun_managed`, a fixed sentinel. When a command sends HTTPS to one of
  `allowedHosts` (exact host names, port 443), egress-gate sets the credential's header on each
  request: `inject.header` (default `Authorization`) with `inject.format` (default
  `Bearer {value}`; `{base64:…}` encodes a part, so `Basic {base64:x-access-token:{value}}`
  works). The value is read from the vault on every request, so a new value applies to the next
  one.
- **`environment_variable`** `{ type, value }`: a plain variable every command sees, such as a
  region or an organization name. Its value is not listed, but every command in the sandbox can
  read it.

```bash
# The slot GH_TOKEN of the Agent's manifest: { "type": "environment_secret", "allowedHosts": ["api.github.com", "github.com"] }
curl -X PUT "$RUNTIME/v1/agents/users%2Falice%2Fweb/secrets/GH_TOKEN" \
  -H "Authorization: Bearer $NYLORUN_SERVER_KEY" -H "Nylorun-Protocol: 16" \
  -H "Content-Type: application/json" \
  -d '{"value":"ghp_…"}'
```

How it works: pods trust one installation egress CA (keys holds its key; the join answer
carries its certificate and the engine points `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and `AWS_CA_BUNDLE` at a bundle of the
public roots plus that CA). For a bound host, egress-gate terminates TLS with a short-lived leaf
for that host, sets the header and forwards the request over verified TLS to the address it
checked. Every other host stays an opaque tunnel. A CLI that pins certificates or ignores those
variables cannot use this path; HTTP/2-only and WebSocket endpoints are not served on it.

A second `environment_secret` bound to a host another one already has is refused at the write
with `409 credential_conflict`. Every session on the Agent gets its secrets, so set the
owner guard (`owner`) on an Agent that holds a person's own token. Pod Agents
only: a virtual one gets the variables but no header. A refused release is a `502` to the CLI and
an `egress_credential_refused` line in the gateway's log, never a session event. Write, replace
and delete them in Studio (type **Secret** or **Variable**), with
`client.agents.secrets` in `@nylorun/agents`, or on the Runtime API.

### An outside credential provider

A platform that keeps people's keys itself, outside the Runtime, can hand them to egress-gate
instead of writing them into Agents' vaults (Host feature `credential-provider`). The Host's
operator names it on `nylorun start`:

| Setting | What it sets |
| --- | --- |
| `NYLORUN_CREDENTIAL_PROVIDER_URL` | The provider's base URL, `http` or `https`, such as `http://172.17.0.1:18793/edge/provider` |
| `NYLORUN_CREDENTIAL_PROVIDER_TOKEN` | The bearer the provider accepts: at least 16 printable characters |

`nylorun start` passes both from its shell to the `gateway` container (egress-gate) and the
`runtime` container (each segment's variables). For a pod Agent with an owner guard (`owner`),
the Runtime then calls, each with `Authorization: Bearer <token>`:

| Call | Body | Answer |
| --- | --- | --- |
| `POST <url>/v1/hosts` | `{ "agentId", "owner" }` | `{ "hosts": [...] }`: the hosts the owner's keys are bound to, each an exact host name or a `*.<suffix>` pattern such as `*.googleapis.com` |
| `POST <url>/v1/environment` | `{ "agentId", "owner" }` | `{ "variables": [...] }`: the variables each command sees, each a name (set to `nylorun_managed`), `{ "name", "standIn" }` (set to that stand-in) or `{ "name", "value" }` (set to that plain value) |
| `ANY <url>/v1/forward/<path and query>` | One request of the sandbox's | The upstream's answer, streamed |

A host the provider lists passes the sandbox's allowlist on port 443, inside the Tenant's egress
ceiling (`limits.network` of `environments.config`, when the Tenant sets one). egress-gate
terminates TLS for it as for a bound secret and sends each request to the forward route with the
sandbox's own headers, its `Authorization` or inject header included (the provider replaces it),
less `host` and any `nylorun-provider-*`, plus `nylorun-provider-host` (the host),
`nylorun-provider-agent`, `nylorun-provider-owner` and `nylorun-provider-token` (the provider's
token, kept apart from the sandbox's own `Authorization`). The provider sends it on to
`https://<host>/<path>`. The Runtime never sees a value. A secret of the Agent's vault bound to the
same host wins, and a vault variable of the same name stays. Answers are kept per Agent for
`credentialProvider.cacheMs`. An Agent with no owner is never asked about. A provider that fails
answers nothing, so its hosts are refused as before (`host_not_allowed`), logged once as
`credential_provider_failed`.

A `*.<suffix>` host matches as one in `network.allow` does: `*.googleapis.com` holds
`run.googleapis.com` and `a.b.googleapis.com`, never `googleapis.com` itself, and the forward
route's `nylorun-provider-host` is the host the sandbox addressed, never the pattern. An IP literal
or a malformed entry is dropped. A variable's `standIn` or `value` is 1 to 1,024 printable
characters with no control character or line break; an entry with anything else, or a name a shell
can't set, is dropped, and the first entry for a name wins. A `value` is set as it is, for a
setting beside a key (a team or a site), never a secret: the sandbox sees it. A names-only answer
from an older provider still works.

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
- **Your own harness.** An agent manifest's `harness.id` names the harness that runs its
  sessions' turns (`nylorun` when unset). A harness of your own runs as a pod's `image`: a
  manifest that names one needs `runtime.kind` `pod` with an `image`, or its save is
  `422 manifest_inconsistent`. An Agent's harness is fixed for its life: to run another
  harness, save a manifest version that names it, fork the Agent onto that version, and open
  new sessions on the fork. A session pins its harness when it opens. If its Agent's id is
  deleted and made again with another harness, the session's next turn is
  `409 harness_mismatch`: open a new session. See [HARNESS_API.md](./HARNESS_API.md).

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
