# Runtime deployment

This release supports one machine: the **local Docker stack** that
`nylorun start` runs (the Runtime, Studio, Postgres, Restate and s2-lite, as
Docker Compose project `nylorun`), with **Tenants** served by that Runtime and
customer executors running on the same machine. Vocabulary:
[runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

```sh
npx nylorun start
npm run build
eval "$(npx nylorun status --env)"
npm start
```

`nylorun start` starts the stack, or leaves it running when it already is, and
prints the Runtime URL and a Studio login URL. `npm start` runs
`node dist/src/main.js`, which connects the application's executor to the
Runtime with three variables: `NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT` and
`NYLORUN_SERVER_KEY`. `nylorun status --env` prints them for the Project that
`nylorun dev` linked; a supervisor can set them directly instead. The
application does not start the stack, Studio or a file watcher; start the
stack first (`nylorun start`), under the same supervisor if you use one.

Keep the **Host root** (`NYLORUN_HOME` or `~/.nylorun`) private and persistent
across ordinary restarts: `host.json`, the admin key in
`host-credentials.json`, the stack's `stack/.env` and Compose file, and every
Tenant directory. The databases live in the stack's Docker volumes. Keep each
Project's `.nylorun/link.json` and `credentials.json` private as well; model
credentials live in the Tenant's vault. `nylorun stop` stops the containers and
keeps the volumes; `nylorun reset` deletes the volumes and every Tenant.

Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the
new Runtime. They described the previous host and are not supported deployment
paths for this beta.

## Container images

Each release publishes the Runtime and Studio as multi-arch images
(`linux/amd64`, `linux/arm64`), tagged with the package version:

| Image | Built from |
| --- | --- |
| `ghcr.io/nylorun/runtime:<runtime version>` | `runtime/Dockerfile` |
| `ghcr.io/nylorun/studio:<studio version>` | `studio/Dockerfile` |

`nylorun start` runs the versions its CLI release pins (`cli/package.json`
`nylorun.runtime` and `nylorun.studio`) beside the official Postgres, Restate
and s2-lite images. `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` replace
the pinned images, for example with a local build. Tags are never moved, and
there is no `latest` tag. Studio is not published to npm; it ships only as its
image, and `local.nylorun.studio` no longer hosts it.

Remote ingress, TLS, server deployment of these images (Compose on a server,
Helm), replicas, hosted customer executors, backups/migrations, crash recovery
qualification, and deployment automation are deferred. Local build and smoke
results do not establish those deployment guarantees.
