# Runtime deployment

This release supports one machine: the **local Docker stack** that
`nylorun up` runs (the Runtime, its gateway, Studio, Postgres, Restate and
s2-lite, as Docker Compose project `nylorun`), with **Tenants** served by that Runtime and
the application's **Action endpoints** (the tools it serves) on the same machine
or reachable from it. Vocabulary:
[runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

```sh
npx nylorun up
npm run build
eval "$(npx @nylorun/cli env)"
npm start
```

`nylorun up` starts the stack, or leaves it running when it already is, and
prints the Runtime and Studio URLs. `npm start` runs
`node dist/src/main.js`, which serves the application's Action endpoint and
registers it with the Runtime using three variables: `NYLORUN_RUNTIME_URL`,
`NYLORUN_TENANT` and `NYLORUN_SERVER_KEY`, or through the Project link. The
Runtime calls that endpoint for every tool call, so its URL
(`NYLORUN_ACTIONS_URL` in the starter) must be reachable from the Runtime: the
local stack maps `localhost` to this machine. `nylo env`
(`npx @nylorun/cli env`) prints them for the Project that `nylo tenant create`
linked; a supervisor can set them directly instead. The application does not
start the stack, Studio or a file watcher; start the stack first
(`nylorun up`), under the same supervisor if you use one.

Keep the **Host root** (`NYLORUN_HOME` or `~/.nylorun`) private and persistent
across ordinary restarts: `host.json`, the admin key in
`host-credentials.json`, the stack's `stack/.env` and Compose file, and every
Tenant directory. Tenant data lives in the stack's Docker volumes: Postgres (each
Tenant's schema), s2-lite (session history), Restate and the workspaces. Keep each
Project's `.nylorun/link.json` and `credentials.json` private as well; model
credentials live in the Tenant's vault. `nylorun down` (or `stop`) stops the
containers and keeps the volumes; `nylorun reset` deletes the volumes and every Tenant.

Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the
new Runtime. They described the previous host and are not supported deployment
paths for this beta.

## Serving people through an app server

To put agents in front of people, run your own **app server** (vocabulary in
[CONTEXT.md](./runtime/src/CONTEXT.md)): it signs people in, holds the Tenant
key, and calls the Runtime for each person with
`client.as(subject, { scopes })` or the AG-UI handler
([agents/README.md](./agents/README.md#acting-for-a-person-app-servers); a
complete web backend is in
[examples](./examples/README.md#an-agent-in-your-web-app-ag-ui)). The Runtime
enforces the scopes and each subject's ownership of sessions and vaults itself.

- Keep the Runtime off the network. An app server on the same machine calls
  `http://localhost:<port>` (the URL `nylorun up` prints). An app server
  container joins the stack's Compose network and calls `http://runtime:4000`,
  which the stack already accepts as a `Host`. An app server on another
  machine reaches it through a reverse proxy:
  [Reaching the Runtime from another machine](#reaching-the-runtime-from-another-machine).
- Never publish the Runtime, Studio or Restate ports beyond loopback, and keep
  Studio for operators (loopback or an SSH tunnel). Leave
  `NYLORUN_STUDIO_FRAME_ANCESTORS` unset on servers: no page may frame Studio.
- The app server drops every `Nylorun-*` header its own clients send, never
  forwards `Origin` (the Runtime refuses Tenant keys from browsers), and
  terminates TLS for its clients.
- The admin key and any application keys stay on the server; clients get
  nothing. A server that holds the admin key can derive its Tenant key instead
  of storing one (`admin.deriveTenantKey`, derived principals).
- Removing a person is the app server's decision: it stops acting for them and
  closes their open streams. If it also minted subject tokens for them, it
  revokes them too (`app.access.revokeSubject`).

## Calling the Runtime from browsers and apps

A browser or a mobile app can call the Runtime itself, without carrying its
requests through your app server (optional features `subject-tokens` and
`browser-access`). Your app server keeps signing people in and mints a
short-lived subject token for each; the page ships a publishable key.

1. Write the access policy once: which roles exist, which agents each may use,
   and their limits (`npx @nylorun/cli access policy init`, then
   `access policy set <file>`).
2. Create a publishable key per app, listing the origins that serve it:
   `npx @nylorun/cli access keys create --name web --origin https://app.example.com`.
   Use `--origin http://localhost:*` for development; an app with no web
   origin gets none.
3. Add a token route to your app server (`createTokenEndpoint` from
   `@nylorun/agents`): same-origin `POST`, behind your sign-in, no CORS.
4. In the page, `createBrowserClient` from `@nylorun/agents/browser` takes the
   Runtime URL, the publishable key and a function that calls the token route.

The local stack allows browser requests (`NYLORUN_BROWSER_ACCESS`, on by
default in the stack; `off` refuses every `Origin`). A Host started from
`host.json` allows them only with `"browserAccess": true`. With no publishable
key, every request with an `Origin` is still refused. CORS headers come from the
Runtime after it checks the key and its origins; a reverse proxy passes
`OPTIONS`, `Origin` and `Nylorun-Key` through and never adds its own. A page
served over HTTPS can only call a Runtime served over HTTPS.

## Reaching the Runtime from another machine

When your app server runs on another machine (a laptop reaching a Mac mini on
the LAN, or a cloud backend reaching a server), put a reverse proxy in front of
the Runtime on the Runtime's machine. The stack publishes the Runtime on
`127.0.0.1` only and accepts only its own `Host` names, so the proxy is the one
way in. Nothing in the Runtime changes.

| Proxy rule | Why |
| --- | --- |
| Listen with TLS; forward to `127.0.0.1:<port>` (the port `nylorun up` prints) | The Tenant key travels on every request and controls the whole Tenant |
| Rewrite `Host` to `localhost:<port>` | The stack answers `421` to any other `Host` |
| Forward to the Runtime port only (`NYLORUN_PORT`); never the operator port (`NYLORUN_ADMIN_PORT`), Studio or Restate | The Admin API is on its own port and stays on the machine |
| Answer `/v1/admin/*` with `403` anyway | Defense in depth: the Runtime port already answers admin routes with `404`, and a Runtime without an operator listener still serves them there |
| Forward only `/health`, `/ready` and `/v1/*` | Nothing else is the Tenant API |
| Pass every other header through, and every method including `OPTIONS`: `Authorization`, `Nylorun-Tenant`, `Nylorun-Key`, `Nylorun-Protocol`, `Nylorun-Subject`, `Nylorun-Scopes`, and `Origin` | Your app server sets the `Nylorun-*` headers. The Runtime decides browser access itself: it refuses Tenant keys with an `Origin` and answers CORS only for a publishable key's listed origins, so the proxy never adds CORS headers |
| Don't buffer responses; allow idle streams | Event streams are long-lived SSE with a keepalive every 15 seconds |
| Restrict source addresses where you can; rate-limit at the edge | Limits scanning and guessing |

A [Caddy](https://caddyserver.com) configuration that does all of this
(replace the name and `8787` with your host name and the port `nylorun up`
prints):

```caddyfile
runtime.example.com {
	# One handle runs per request, the first that matches. Keep the admin block
	# first: a bare `respond` would run after the proxy, not before it.
	@admin path /v1/admin /v1/admin/*
	handle @admin {
		# The Admin API is on its own port (never proxied); block it here too.
		respond "Blocked by the reverse proxy" 403
	}

	@api path /health /ready /v1/*
	handle @api {
		reverse_proxy 127.0.0.1:8787 {
			# The stack answers only its own Host names.
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
| Same LAN | Tailscale: name the site after the machine (`mac-mini.<tailnet>.ts.net`) and Caddy fetches its certificate from the local Tailscale daemon. Or a local CA (`tls internal`) whose root the app server trusts (`NODE_EXTRA_CA_CERTS`) | Never plain HTTP on a LAN or Wi-Fi: it exposes the Tenant key. With Tailscale, accept only the tailnet: add `@outside not remote_ip 100.64.0.0/10` with `handle @outside { respond 403 }` as the first block |
| Internet | A public certificate: Caddy obtains one automatically for a public DNS name | Prefer a private path (Tailscale, a VPN or the same cloud network) over a public endpoint; publish publicly only when the backend cannot join one |

On the app server's machine:

- Use an **application key**, never the admin key. Create a Tenant for the app
  on the Runtime's machine with `npx @nylorun/cli tenant create <name>`,
  run outside a Project: it prints the three variables once. Keep the key in
  the app server's secret store.
- Set `NYLORUN_RUNTIME_URL` to the proxy's URL (`https://runtime.example.com`)
  for the client and the Action endpoint's `register`; keep
  `NYLORUN_TENANT` and `NYLORUN_SERVER_KEY` as printed. Register the app's
  Action endpoint at a URL the Runtime's machine can reach (the app server's
  address on the network, or a tunnel), and allow that traffic.
- To check a placement end to end, run the remote check from a checkout of this
  repository on the app server's machine, against a Tenant made for it:

  ```sh
  npm ci && npm run build --workspace @nylorun/core --workspace @nylorun/agents
  node scripts/acceptance/remote.mjs --placement lan --fixture-model \
    --actions-url https://tunnel.example.com/nylorun/actions --actions-port 3000
  ```

  `--actions-url` is where the Runtime reaches the check's Action endpoint, which
  listens on `--actions-port` on the app server's machine (a tunnel, or the machine's
  address when the Runtime can reach it). The check verifies the proxy rules, runs a
  chat with an approval, drops the connection and reattaches, then keeps an event
  stream open through ten idle minutes (`--idle-minutes`) and checks that tools are
  still delivered afterwards. `--fixture-model` switches that Tenant's
  model calls to the Runtime's deterministic fixture model.

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
the Runtime's stream relay feeds s2-lite from it over **logical replication**. The local
stack starts Postgres with the settings it needs; a Postgres you run yourself needs them
too:

| Setting | Value | Why |
| --- | --- | --- |
| `wal_level` | `logical` | The relay reads committed events from a replication slot. Changing it restarts Postgres |
| `max_replication_slots`, `max_wal_senders` | at least 2 (the default 10 is enough) | One slot, `nylorun_stream_relay` |
| `max_slot_wal_keep_size` | a few GB (the stack uses 4GB) | A stuck relay cannot fill the disk; a lost slot only costs a reconciliation |
| The Runtime's role | `REPLICATION`, plus read access to `nylorun_streams` | The relay reads every Tenant's events (the stack's `nylorun` role is a superuser) |

On a managed Postgres, turn on its logical replication option (for example
`rds.logical_replication` on RDS). With S2 down, commits continue and the slot keeps their
WAL; the relay catches up in order when S2 returns.

## The gateway: model calls

The stack runs the Runtime image twice (the combined packing). The `runtime`
container runs the `core` and `loop` services: the APIs, Studio's backend and
the agent loop. The `gateway` container runs `gates`, the Model Gate: it reads
the Tenant's model credential from its vault and calls the provider. The loop
sends every vault-backed model call to it (`NYLORUN_GATES_URL`) and never holds
a model credential.

- The gateway has no published port; only the runtime reaches it, on the stack
  network, with `NYLORUN_GATES_TOKEN` from `stack/.env`. `nylorun up` generates
  the token once and keeps it.
- It mounts only the Host root's `tenants/` directory, read-only (the Tenants'
  vault keys), never `host-credentials.json`, and writes nothing there.
- It reaches model servers on this machine (Ollama, for example) at
  `host.docker.internal`.
- While it is down, model calls fail with a retryable `transient` outcome and
  the session takes the next message; reads, commands and Studio keep working.
  `nylorun doctor` and `nylorun status` report it, and `nylorun logs gateway`
  shows one `model_call` line per call (never the prompt, the output or a key).
- A Compose file you write yourself must run both containers: in a container,
  a Runtime that runs `loop` refuses to start without `NYLORUN_GATES_URL` and
  `NYLORUN_GATES_TOKEN`. A proxy between the two must allow an idle request of
  at least 630 s, because the gate answers only when the call has finished.

The combined packing suits one developer on one machine. The vault key files
are still mounted into the runtime container too, for MCP and signing keys,
until a later release moves them into a keys service.

## Container images

Each release publishes the Runtime and Studio as multi-arch images
(`linux/amd64`, `linux/arm64`), tagged with the package version:

| Image | Built from |
| --- | --- |
| `ghcr.io/nylorun/runtime:<runtime version>` | `runtime/Dockerfile` (the `runtime` and `gateway` containers) |
| `ghcr.io/nylorun/studio:<studio version>` | `studio/Dockerfile` |

`nylorun up` runs the versions its release pins (`nylorun/package.json`
`nylorun.runtime` and `nylorun.studio`) beside the official Postgres, Restate
and s2-lite images. `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace
the pinned images, for example with a local build. Tags are never moved, and
there is no `latest` tag. Studio is not published to npm; it ships only as its
image.

Remote ingress, TLS, server deployment of these images (Compose on a server,
Helm), replicas, hosted customer Action endpoints, backups/migrations, crash recovery
qualification, and deployment automation are deferred. Local build and smoke
results do not establish those deployment guarantees.
