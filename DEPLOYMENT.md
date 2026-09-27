# Runtime Host deployment

This release supports one local Node 24 **Runtime Host** process with SQLite
**Tenants**, connected customer executors, and optional local Studio.
Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

```sh
npm run build
npm start
```

`npm start` runs `nylorun serve`, which loads `dist/agents/index.js`, attaches
to the Runtime Host on loopback (default port 8787; `--port` override) and
connects the SDK executor for the linked Tenant. It does not start Studio or
watch files. If no Host is listening it starts one in the background and leaves
it running. For a container or any supervised deployment, start the Host
explicitly — `nylorun runtime up`, or run `@nylorun/runtime/server` as its own
process under a dedicated Host root — and pass `nylorun serve --no-autostart` so
a missing Host fails the process instead of spawning an unsupervised one.

Keep the **Host root** (`NYLORUN_HOME` or `~/.nylorun`) private and persistent
across ordinary restarts: `host.json`, admin credentials, installed runtimes,
and every Tenant directory. Keep each Project's `.nylorun/link.json` and
`credentials.json` private as well. The first Project run stores the provider
credential in that Tenant's vault. `nylorun runtime down` stops the Host and
keeps Host config and Tenants.

For explicit standalone Host configuration, see [Runtime](runtime/README.md).
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
