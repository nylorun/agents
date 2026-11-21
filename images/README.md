# Container images

The container images built from this folder. The Runtime's and Studio's images are built from
their own packages ([`runtime/server`](../runtime/server), [`studio`](../studio)); see
[docs/reference/packages.md](../docs/reference/packages.md) for every image.

| Folder | Image | What it is |
| --- | --- | --- |
| [`dev/`](./dev/README.md) | `ghcr.io/nylorun/dev` | A coding agent's computer: Ubuntu with the base toolchain, for a sandbox pod |
| [`dev-engine/`](./dev-engine/README.md) | `ghcr.io/nylorun/dev:engine-<runtime>` | The dev image with one Runtime version's engine built in |
| [`computer/`](./computer) | `ghcr.io/nylorun/computer` | The computer agent: one static binary that serves a sandbox's commands and files |

Each folder has a `smoke.sh` that CI runs against the built image.
