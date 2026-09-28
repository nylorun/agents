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
([agents/README.md](./agents/README.md#acting-for-a-person-app-servers)). The
Runtime enforces the scopes and each subject's ownership of sessions and vaults
itself.

- Keep the Runtime off the network. An app server on the same machine calls
  `http://localhost:<port>` (the URL `nylorun up` prints). An app server
  container joins the stack's Compose network and calls `http://runtime:4000`,
  which the stack already accepts as a `Host`. An app server on another
  machine needs a reverse proxy in front of the Runtime; that recipe is not
  part of this release.
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
