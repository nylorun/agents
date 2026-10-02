---
"nylorun": minor
---

**A stack's Docker Compose files live in `docker/`.** `compose.yaml`, `.env` and `restate-identity.pem` are written to `~/.nylorun/stacks/<name>/docker/` (or `$NYLORUN_HOME/docker/`), so the folder says what it holds: to change a port, edit `docker/.env`. The single stack of older releases keeps its `~/.nylorun/stack/`, which `nylorun legacy` reads as it is.
