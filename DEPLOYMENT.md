# Runtime deployment

This release supports one machine: the **local Tenant** that `nylorun start`
runs for a project (the Runtime, its gateway and harness, Studio, Postgres, Restate,
s2-lite and RustFS, as Docker Compose project `nylorun-<tenant>`), an installation that
serves that one **Tenant**, and the application's **Action
endpoints** (the tools it serves) on the same machine or reachable from it. Vocabulary:
[runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

```sh
npx nylorun start
npm run build
eval "$(npx @nylorun/cli env)"
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
this machine). `nylo env`
(`npx @nylorun/cli env`) prints them for the Project that `nylorun start`
linked; a supervisor can set them directly instead. The application does not
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
containers and keeps the volumes; `nylorun reset` deletes the volumes, the
Tenant directory and the vault key, so the next start creates a new Tenant; `nylorun delete
<tenant>` removes its containers, volumes and Host root altogether.

Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the
new Runtime. They described the previous host and are not supported deployment
paths for this beta.

To run an installation for a team with your own identity provider and secret
store, read [SELF_HOSTING.md](./SELF_HOSTING.md): the front doors, application
and management keys, the identity file, credentials, Studio behind a sign-in proxy, CORS,
private addresses and backups, with a runnable stack in
[examples/self-host](./examples/self-host/README.md).

## Serving people through an app server

To put agents in front of people, run your own **app server** (vocabulary in
[CONTEXT.md](./runtime/src/CONTEXT.md)): it signs people in, holds an
application key, and calls the Runtime API for each person with
`client.as(subject, { scopes })` or the AG-UI handler
([agents/README.md](./agents/README.md#acting-for-a-person-app-servers); a
complete web backend is in
[examples](./examples/README.md#an-agent-in-your-web-app-ag-ui)). The Runtime
enforces the scopes and each subject's ownership of sessions itself. Vaults
are the installation's: operators manage them through the Management API with a
management key, and the app server attaches them to sessions by id (`vaultIds`)
([Credentials](#credentials)).

- Keep the Runtime off the network. An app server on the same machine calls
  `http://localhost:<port>` (the URL `nylorun up` prints). An app server
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
  server its own application key (`npx nylorun key put <name>`, or
  `admin.keys.put(name)` in `@nylorun/admin` with a management key), so you can
  rotate or delete one without touching the others; the Runtime keeps only its
  hash. An app server needs no management key and never the admin key: an
  application key reaches only the Runtime API, so a leaked one cannot reset the
  Tenant, read vaults or rotate signing keys. No key is derived from the admin
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
    audience: nylorun                            # the aud they must carry
    jwks: https://sso.acme.dev/realms/eng/protocol/openid-connect/certs  # or keys: [<PEM>, …]
    subject: "u:{sub}"                           # the owner of the person's sessions; scalar claims only
    scopes: { claim: nylorun_scopes }            # or { fixed: [sessions:own, agents:read] }
    allowedScopes: [agents:read, sessions:own, sandboxes:write, studio]
    agents: [support]                            # optional; absent reaches every agent
    sandboxes: ["{org_id}/*"]                    # optional grant templates; absent reaches none
    maxLifetime: 15m                             # the longest exp - iat accepted
```

- Tokens must be RS256, ES256 or EdDSA, at most 16 KiB, with `exp` and `iat`.
  Their scopes are the claim's, limited to `allowedScopes` (`agents:read`,
  `sessions:own`, `sandboxes:write`, and `studio`, an operator scope for
  Studio). A sandbox grant whose
  claim is missing, or is not one id segment, reaches nothing.
- A malformed file stops the runtime, naming the issuer and the field; a
  subject template must reference a claim, or everyone would be one person.
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
| Forward only `/health`, `/ready` and `/v1/*` | Nothing else is the Runtime API or the Management API |
| Optional: answer `/v1/tenant/*` with `403` unless the request comes from your operator networks | Defense in depth for the Management API, on top of the key role. Leave `/v1/oauth/callback` open: browsers come back to it |
| Pass every other header through: `Authorization`, `Nylorun-Protocol`, `Nylorun-Subject`, `Nylorun-Scopes`, and `Origin` | Your app server sets the `Nylorun-*` headers. The Runtime refuses keys sent with an `Origin` |
| Answer CORS yourself, for your app's origins only, when browsers call the Runtime: preflights (`OPTIONS`) and `Access-Control-Allow-Origin`; allow `Authorization`, `Content-Type`, `Nylorun-Protocol` and `Last-Event-ID`, and expose `Retry-After` and `WWW-Authenticate` | The Runtime sends no CORS headers (protocol 7); browsers present a trusted issuer's token |
| Don't buffer responses; allow idle streams | Event streams are long-lived SSE with a keepalive every 15 seconds |
| Restrict source addresses where you can; rate-limit at the edge | Limits scanning and guessing |

A [Caddy](https://caddyserver.com) configuration that does all of this
(replace the name and `8787` with your host name and the port `nylorun up`
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
  installation and links it; `npx @nylorun/cli env` there prints the key
  (`NYLORUN_SERVER_KEY`, the application key `project`). Better, give the app
  server a key of its own: `npx nylorun key put app-server` prints one once.
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

## Sandboxes

A Runtime runs sessions' sandboxes on the in-process **virtual** backend: an
emulated bash with a virtual filesystem, whose `/workspace` is kept under the
Tenant's directory. It is not a VM or container boundary. Egress is limited to
the exact hosts the session's sandbox allows, and a sandbox cannot name an
image. `npx nylo doctor sandbox` reports the backend in use.

## Postgres for session events

Postgres holds the record of every session event (`nylorun_streams.session_events`), and
the Runtime's stream relay feeds s2-lite from it over **logical replication**. A local
Tenant starts Postgres with the settings it needs; a Postgres you run yourself needs them
too:

| Setting | Value | Why |
| --- | --- | --- |
| `wal_level` | `logical` | The relay reads committed events from a replication slot. Changing it restarts Postgres |
| `max_replication_slots`, `max_wal_senders` | at least 2 (the default 10 is enough) | One slot, `nylorun_stream_relay` |
| `max_slot_wal_keep_size` | a few GB (`nylorun start` uses 4GB) | A stuck relay cannot fill the disk; a lost slot only costs a reconciliation |
| The Runtime's role | `REPLICATION`, plus read access to `nylorun_streams` | The relay reads the Tenant's events (a local Tenant's `nylorun` role is a superuser) |

On a managed Postgres, turn on its logical replication option (for example
`rds.logical_replication` on RDS). With S2 down, commits continue and the slot keeps their
WAL; the relay catches up in order when S2 returns.

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
- `nylorun logs rustfs` shows its log. RustFS uses about 75 MB of memory when idle.

## The gateway: model and tool calls

A local Tenant runs the Runtime image twice (the combined packing). The `runtime`
container runs the `core` and `loop` services: the APIs, Studio's backend and
the agent loop. The `gateway` container runs `gates`, the Model Gate: it reads
the Tenant's model credential from its vault and calls the provider. The loop
sends every vault-backed model call to it (`NYLORUN_GATES_URL`) and never holds
a model credential.

- The gateway has no published port; only the runtime and the harness reach it,
  on the Compose networks. It accepts two credentials:
  - **Core's credential**, `NYLORUN_GATES_TOKEN` from `docker/.env`. `nylorun up`
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
  `nylorun doctor` and `nylorun status` report it, and `nylorun logs gateway`
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
- A Compose file you write yourself must run both containers: in a container,
  a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and
  `NYLORUN_GATES_TOKEN`. A proxy between the two must allow an idle request of
  at least 630 s, because the gate answers only when the call has finished.

The gateway is also the Tool Gate. Tool calls that leave the loop cross it, so
the runtime container never holds an MCP credential or calls a tool's server:

- **Remote MCP servers** (`streamable-http` and `sse`): the gateway opens the
  connection, authorizes it from the session's attached vaults (OAuth refresh
  included) and runs `tools/list` and `tools/call`. `nylorun logs gateway`
  shows one `mcp_request` line per request, never arguments, results or
  credentials. Nylorun accepts remote MCP servers only: there are no stdio
  servers to run.
- **HTTP tools**: the gateway POSTs every HTTP tool call, so it carries
  `NYLORUN_ENDPOINT_LOOPBACK` (and any other `NYLORUN_ENDPOINT_*` setting) and
  reaches services on this machine at `host.docker.internal`.
- A remote MCP call outlives the runtime that sent it, like a model call: a
  restarted runtime picks up its answer. The gateway records each call in the
  `tool_crossings` table before it reaches the server, so after a gateway
  restart a call that was in flight is `uncertain`: it may have run, and it is
  never run again.

### Credentials

A session's MCP credential comes from two places, in this order:

1. **The session's attached vaults.** An installation vault
   (`POST /v1/tenant/vaults` with `scope: "installation"`, or
   `admin.vaults.create` in `@nylorun/admin`; Studio's Connections page creates
   these) holds the installation's own credentials: shared tool keys and the
   operator's MCP connections. Any session may attach one (`vaultIds`). Vault
   routes are the Management API's and take only a management key (protocol 8):
   an application key, alone or acting for a person, gets
   `403 key_role_mismatch`. A person's vault (owner `ownerUserId`) still
   attaches only to that person's sessions.
2. **Your credential resolver**, for a person's own credentials, which Nylorun
   never stores. Set `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN` on the
   gateway (a local Tenant passes them from the shell that runs `nylorun
   start`). When the attached vaults hold nothing for the server's URL, the
   gateway asks:

   ```text
   POST <NYLORUN_RESOLVER_URL>
   Authorization: Bearer <NYLORUN_RESOLVER_TOKEN>
   { "owner": "u:priya", "session": "s_…", "turn": "t_…" | null,
     "target": { "kind": "mcp", "server": "github", "agent": "support", "url": "https://…/mcp" } }

   200 { "headers": { "authorization": "Bearer …" }, "expiresAt"?: "<ISO time>" }
   404                                      the call goes without a credential
   anything else, or no answer within 5 s   the server is refused: credential_unavailable
   ```

   `owner` and `turn` come from the session, never from the agent. Answers are
   kept per owner and URL until `expiresAt`, at most 5 minutes (60 s without
   one), so a revoked credential can work for up to 5 minutes. Keep the
   resolver on a private network: the gateway allows private addresses for it,
   and never follows a redirect.

### Connecting a remote MCP server with OAuth

An MCP server that signs clients in with OAuth (MCP authorization: RFC 9728
discovery, then RFC 8414 metadata) can be connected once for the whole
installation; the credential goes into an installation vault:

```sh
nylorun mcp connect https://mcp.example.com/mcp --server linear
# a server without dynamic client registration (RFC 7591): register a client
# with it, its redirect URI the callback below, and pass the client's id
nylorun mcp connect https://mcp.example.com/mcp --server linear --client-id <id>
```

The command creates the installation vault `mcp` unless `--vault <id>` names
another, prints the sign-in URL and opens the browser, and waits (up to 10
minutes) for the credential: an `oauth` credential bound to the URL, named
after `--server`, refreshed by the gateway when it expires. Connecting again
rotates it. Sessions use it when they attach the vault (`vaultIds`). A tool of
your own does the same with a management key:
`POST /v1/tenant/vaults/{vaultId}/oauth/start`, or
`admin.vaults.startOAuth(vaultId, { url, server })` in `@nylorun/admin`.

The gateway's `keys` service does every OAuth step: discovery, registration,
the PKCE code exchange and refresh. Tokens, the PKCE verifier and any client
secret never reach the runtime container, which only routes the start and the
callback. The authorization server sends the browser back to
`NYLORUN_PUBLIC_URL` + `/v1/oauth/callback` (`http://localhost:<port>` for a
local Tenant); a server reached through a proxy sets `NYLORUN_PUBLIC_URL` to
its public address. Without one, the callback is the start request's own
origin. A sign-in must finish within 10 minutes, and its `state` works once.

These requests follow the `NYLORUN_ENDPOINT_*` settings, like HTTP tool calls: no redirects, and a local Tenant may reach an OAuth server on this
machine. On a server, set `NYLORUN_ENDPOINT_PRIVATE=refuse` on the gateway so
a discovery document cannot point it at a private address.

The gateway also runs `keys`, the only process that reads the vault key: it
runs every vault write that touches a secret (creating and rotating a
credential, setting and selecting the host model, MCP OAuth connect) and signs every token
(capability links, run and host tokens, signing-key rotation). The runtime reaches
it at `NYLORUN_KEYS_URL` (by default the gateway's `NYLORUN_GATES_URL`) and
never reads the key: Compose covers `keys/` and `docker/` in the runtime
container with empty read-only mounts. While the gateway is down, those
requests answer `503 keys_unavailable`.

The combined packing suits one developer on one machine: the gateway holds
every secret of the Tenant in one process. Kubernetes splits it into separate
services in a later release.

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
  connected`; `nylorun logs harness` shows its log).
- If the harness container is killed mid model call, the gateway keeps the call
  and the restarted harness picks up its answer. A workspace command in flight is
  lost with the container, so its effect becomes `uncertain`
  and the session waits for a decision; nothing runs it twice. If the runtime
  restarts, the harness connects again and the turn finishes.
- **Rollback.** Set `NYLORUN_HARNESS=in-process` in `docker/.env` and run
  `nylorun start`: the runtime container runs turns, MCP servers and workspaces
  itself again, and the harness container is removed. `NYLORUN_HARNESS=remote`
  (the default) brings it back; the setting is kept across starts.

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

`nylorun up` runs the versions its release pins (`nylorun/package.json`
`nylorun.runtime` and `nylorun.studio`) beside the official Postgres, Restate,
s2-lite and RustFS images. `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace
the pinned images, for example with a local build. Tags are never moved, and
there is no `latest` tag. Studio is not published to npm; it ships only as its
image.

Remote ingress, TLS, server deployment of these images (Compose on a server,
Helm), replicas, backups/migrations, crash recovery
qualification, and deployment automation are deferred. Local build and smoke
results do not establish those deployment guarantees.
