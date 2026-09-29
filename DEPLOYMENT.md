# Runtime deployment

This release supports one machine: the **local Docker stack** that
`nylorun up` runs (the Runtime, Studio, Postgres, Restate and s2-lite, as
Docker Compose project `nylorun`), with **Tenants** served by that Runtime and
customer executors running on the same machine. Vocabulary:
[runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

```sh
npx nylorun up
npm run build
eval "$(npx @nylorun/cli env)"
npm start
```

`nylorun up` starts the stack, or leaves it running when it already is, and
prints the Runtime URL and a Studio login URL. `npm start` runs
`node dist/src/main.js`, which connects the application's executor to the
Runtime with three variables: `NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT` and
`NYLORUN_SERVER_KEY`, or through the Project link. `nylo env`
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
  Studio for operators (loopback or an SSH tunnel).
- The app server drops every `Nylorun-*` header its own clients send, never
  forwards `Origin` (the Runtime refuses browser requests), and terminates TLS
  for its clients.
- The admin key and any application keys stay on the server; clients get
  nothing. A server that holds the admin key can derive its Tenant key instead
  of storing one (`admin.deriveTenantKey`, derived principals).
- Removing a person is the app server's decision: it stops acting for them and
  closes their open streams. There is no per-person credential to revoke.

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
| Answer `/v1/admin/*` with `403` | The Admin API shares the Runtime's port; the admin key never leaves the machine |
| Forward only `/health`, `/ready` and `/v1/*`; never proxy Studio or Restate | The operator tools stay on the machine |
| Pass every other header through: `Authorization`, `Nylorun-Tenant`, `Nylorun-Protocol`, `Nylorun-Subject`, `Nylorun-Scopes`, and `Origin` | Your app server sets the `Nylorun-*` headers; the Runtime refuses any request with an `Origin`, so browsers stay out |
| Don't buffer responses; allow idle streams | Event streams and the executor's connection are long-lived SSE with a keepalive every 15 seconds |
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
		# The Admin API shares the Runtime's port; it stays on this machine.
		respond "Blocked by the reverse proxy" 403
	}

	@api path /health /ready /v1/*
	handle @api {
		reverse_proxy 127.0.0.1:8787 {
			# The stack answers only its own Host names.
			header_up Host localhost:8787
			# Event streams and the executor's connection: flush every write.
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
  for both the client and the executor (`connectAgents`); keep
  `NYLORUN_TENANT` and `NYLORUN_SERVER_KEY` as printed.
- To check a placement end to end, run the remote check from a checkout of this
  repository on the app server's machine, against a Tenant made for it:

  ```sh
  npm ci && npm run build --workspace @nylorun/core --workspace @nylorun/agents
  node scripts/acceptance/remote.mjs --placement lan --fixture-model
  ```

  It checks the proxy rules, runs a chat with an approval, drops the connection
  and reattaches, then keeps an event stream and the executor connected through
  ten idle minutes (`--idle-minutes`). `--fixture-model` switches that Tenant's
  model calls to the Runtime's deterministic fixture model.

This is one Runtime on one server, operated by hand: no replicas, managed
backups, Helm charts or upgrade automation.

## Sandboxes on OpenShell

A Runtime runs sessions' sandboxes on the in-process **virtual** backend
unless `NYLORUN_OPENSHELL_GATEWAY` names an
[OpenShell](https://github.com/NVIDIA/OpenShell) 0.1.2 gateway
(`http://host:port`). Then each sandbox is a container on that gateway's
Docker driver, and egress is limited to the hosts the session's sandbox allows.
`nylorun start --sandbox openshell` runs one beside the local stack. The
gateway must be reachable only by the Runtime. It holds the Docker socket, and
the stack's configuration accepts unauthenticated callers on its network.
Kubernetes gateways, mTLS to the gateway and several gateways per Host are
deferred. `npx nylo doctor sandbox` reports the backend in use and why.

## Container images

Each release publishes the Runtime and Studio as multi-arch images
(`linux/amd64`, `linux/arm64`), tagged with the package version:

| Image | Built from |
| --- | --- |
| `ghcr.io/nylorun/runtime:<runtime version>` | `runtime/Dockerfile` |
| `ghcr.io/nylorun/studio:<studio version>` | `studio/Dockerfile` |

`nylorun up` runs the versions its release pins (`nylorun/package.json`
`nylorun.runtime` and `nylorun.studio`) beside the official Postgres, Restate
and s2-lite images. `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace
the pinned images, for example with a local build. Tags are never moved, and
there is no `latest` tag. Studio is not published to npm; it ships only as its
image.

Remote ingress, TLS, server deployment of these images (Compose on a server,
Helm), replicas, hosted customer executors, backups/migrations, crash recovery
qualification, and deployment automation are deferred. Local build and smoke
results do not establish those deployment guarantees.
