# ghcr.io/nylorun/dev

A coding agent's computer (ADR-92 in nylorun/factory): Ubuntu 24.04 with the base toolchain only,
for a sandbox pod that runs as uid 1000 on a read-only root. The engine is not in it; the pod copies
the engine in, as for any image.

| Holds | |
|---|---|
| OS | `ubuntu:24.04` pinned by digest; uid 1000 is the user `ubuntu` |
| Tools | git, git-lfs, curl, wget, jq, ripgrep, fd, tree, unzip, zip, xz, zstd, sqlite3, build-essential, pkg-config, OpenSSL, libffi and zlib headers |
| Runtimes | Python 3.12 with pip and venv; Node 24 with npm, npx and corepack (pnpm, yarn) |
| Installers | uv, and mise for CLIs and other runtimes |

Everything the agent installs goes under `HOME=/workspace` (the pod's disk): `npm install -g` to
`~/.local`, `pip install` to the user site, `uv tool install` and mise to `~/.local`. New releases
wait 3 days before npm, pnpm and uv install them.

```bash
docker build -t nylorun-dev:local images/dev
bash images/dev/smoke.sh nylorun-dev:local
```

The **Dev image** workflow builds and smoke-tests it on a pull request that changes this folder, and
publishes `ghcr.io/nylorun/dev:<YYYY.MM.DD>` for amd64 and arm64 when run by hand from `main`.
