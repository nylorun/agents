# Container images

The container images built from this folder. No computer image is published here: an Agent names its own ([Computer images](../docs/self-hosting/computer-images.md)). The Runtime's and Studio's images are built from
their own packages ([`runtime/server`](../runtime/server), [`studio`](../studio)); see
[docs/reference/packages.md](../docs/reference/packages.md) for every image.

| Folder | Image | What it is |
| --- | --- | --- |
| [`computer/`](./computer) | `ghcr.io/nylorun/computer` | The computer agent: one static binary that serves a sandbox's commands and files |

Each folder has a `smoke.sh` that CI runs against the built image.
