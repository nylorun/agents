# ghcr.io/nylorun/dev:engine-<runtime>

The dev image ([`images/dev`](../dev/README.md)) with one Runtime version's engine built in under
`/opt/nylorun`, so a sandbox pod starts it directly (`entrypoint: "builtin"`, ADR-99 in
nylorun/factory) and a wake copies nothing in. It is published as a tag of the public
`ghcr.io/nylorun/dev` package, one per Runtime version: `engine-0.40.0-beta`.

| Path | What |
|---|---|
| `/opt/nylorun/bin/tini`, `/opt/nylorun/bin/node` | From the Runtime image |
| `/opt/nylorun/engine/` | The bundled engine (`harness.mjs`) and its addon, from the Runtime image |
| `/opt/nylorun/VERSION` | The Runtime version, also the label `dev.nylorun.engine.version` |

The label `dev.nylorun.base` names the dev image it was built from, pinned in [`dev.image`](dev.image).

To use it, pin it by digest in an agent's `runtime.json` (`"image"`) and list `ghcr.io/nylorun/dev`
in the Tenant's `engine.images`. While that is listed, pin only `engine-*` builds of `dev` on that
Tenant: a plain `dev` image has no engine to start. If the Tenant runs a newer Runtime than the
image's engine, pods copy the Runtime's engine in as for any image: slower, never broken.

```bash
docker build --build-arg DEV="$(cat images/dev-engine/dev.image)" --build-arg RUNTIME_VERSION=0.40.0-beta -t dev-engine:local images/dev-engine
bash images/dev-engine/smoke.sh dev-engine:local
```

The **Dev engine image** workflow builds and smoke-tests it on a pull request that changes this
folder, and, run by hand from `main` with a Runtime version, publishes
`ghcr.io/nylorun/dev:engine-<runtime>` for amd64 and arm64 once per version.
