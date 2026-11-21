# Computer images

Every Agent of kind `pod` runs its commands and files on a **computer**: its own actor on Agent
Substrate (or a pod on agent-sandbox, for a laptop or CI). The computer runs the image the Agent
names in `runtime.json`, pinned by digest, or `python:3.13-slim` when it names none. Nylorun
publishes no computer image of its own: you choose one, or build one with the recipe below.

## What the Runtime adds

An image needs no engine. Around it, the Runtime adds:

| Added | What |
| --- | --- |
| The computer agent at `/nylo` | A static binary in its own image (`ghcr.io/nylorun/computer`), mounted read-only, run as the container's first process. It serves commands and files to the harness and checks every ticket. With `computer.agent: engine`, the Runtime's engine serves them instead, from the Runtime image |
| `/workspace` | The Agent's durable disk, `HOME` for every command. What a task installs there (with `npm`, `pip`, `uv`, `mise`) is still there after a suspend and in the Agent's disk versions |
| `/skills` | The session's skills, written by the Runtime |
| Trust | Substrate's egress CA, added to the image's bundle in `/tmp/nylorun-trust.pem`, with `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and `AWS_CA_BUNDLE` pointing at it |
| Network | Only the hosts the Agent's `network.allowedHosts` names (and the Tenant's limits allow) |

So a computer image is the tools a task needs, and nothing else.

## What an image can rely on, and what it can't

- **Any Linux image.** glibc, musl (Alpine) or distroless: the computer agent is a static binary.
  Commands run under `/bin/bash -c`, or `/bin/sh` without bash.
- **Its own user.** The image's `USER` runs every command. A non-root user (uid 1000 is common) is
  the usual choice; a command can't `apt-get install` then, so put system packages in the image.
- **Nothing installed at run time outside the home.** Treat the root filesystem as read-only: on
  agent-sandbox it is, and on Substrate only `/workspace` and `/skills` survive a suspend. Point
  installers at the home (`NPM_CONFIG_PREFIX=/workspace/.local`, `MISE_DATA_DIR`, `PATH`
  including `/workspace/.local/bin`), as the recipe does.
- **Every host it downloads from is allowed.** List your installers' hosts (`registry.npmjs.org`,
  `pypi.org`, `files.pythonhosted.org`, `github.com`…) in the Agent's `network.allowedHosts`.
- **Pin by digest.** The Runtime refuses a tag in `runtime.image`, so every node runs the same bytes.

## Getting the image onto the nodes

- **Pre-pull it.** A new digest is a cold pull on every node. Add it to the chart's
  `prepull.images`, so a computer's first wake unpacks nothing.
- **A private registry.** Substrate's templates carry no pull credentials, so the nodes must be
  able to pull the image with their own identity. Publish it where the nodes can read it, or mirror
  it there.
- **Mirrors** (`sandboxes.imageMirrors` in the chart, `imageMirrors` in `cluster.json`). Map the
  repository the Agent names to one in the cluster's own registry, such as Artifact Registry on
  GCP read with the node's service account:

  ```yaml
  sandboxes:
    imageMirrors:
      ghcr.io/acme/computer: europe-west1-docker.pkg.dev/acme-prod/computers/computer
  prepull:
    images:
      - europe-west1-docker.pkg.dev/acme-prod/computers/computer@sha256:…
  ```

  Copy each digest there first; `crane copy` keeps it:

  ```bash
  crane copy ghcr.io/acme/computer@sha256:… europe-west1-docker.pkg.dev/acme-prod/computers/computer
  ```

  The node pulls the mirror, and the Runtime still reads the name the Agent asked for, so the same
  agent folder runs on a laptop (from the publisher) and in the cluster (from the mirror).

## A coding computer: a recipe

A starting point for an agent that clones repositories, builds and tests them, and uses a
browser: Ubuntu 24.04 with the base toolchain, Python with uv, Node with npm, pnpm and yarn, mise
for other runtimes and CLIs, and Playwright's Chromium. New releases wait 3 days before npm, pnpm
and uv install them. Copy it, add the tools your agents use most, and publish it yourself.

```dockerfile
# syntax=docker/dockerfile:1
# Build: docker build -t my-computer .
# It runs as uid 1000 (`ubuntu`) with HOME=/workspace: every installer below writes under
# /workspace/.local, which survives a suspend.
ARG BASE_IMAGE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0

FROM ${NODE_IMAGE} AS node
FROM ${UV_IMAGE} AS uv

FROM ${BASE_IMAGE}
ARG TARGETARCH
ARG MISE_VERSION=2026.10.23
ARG MISE_SHA256_AMD64=a6ac620e73fb58cefbdfef8fb154856fbd8ae08d75ae88103e4b81daef3a836e
ARG MISE_SHA256_ARM64=7a4032ee0f637e2333b78ef937bdffc90efed799a4a85fa64c393799cc428731

# 1. The OS layer: what the agent can never add itself (no root, read-only root filesystem).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg openssh-client \
      git git-lfs \
      bash-completion less file procps tree jq ripgrep fd-find \
      unzip zip xz-utils zstd bzip2 \
      build-essential pkg-config libssl-dev libffi-dev zlib1g-dev \
      python3 python3-dev python3-venv python3-pip \
      sqlite3 tzdata locales \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# 2. Node 24 LTS with npm and corepack (pnpm, yarn), from Node's own image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable --install-directory /usr/local/bin pnpm yarn

# 3. The installers: uv (Python tools and versions) and mise (CLIs and other runtimes).
COPY --from=uv /uv /uvx /usr/local/bin/
RUN arch="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" \
 && sum="$([ "$TARGETARCH" = arm64 ] && echo "$MISE_SHA256_ARM64" || echo "$MISE_SHA256_AMD64")" \
 && curl -fsSL -o /usr/local/bin/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}" \
 && echo "${sum}  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise

# 4. A browser: Chromium's libraries and base fonts (Playwright's ubuntu24.04 list for Chromium),
#    @playwright/cli, and the headless shell and FFmpeg builds that CLI expects, under
#    /opt/ms-playwright on the read-only root. The CLI defaults to the Google Chrome channel, which
#    isn't here, so PLAYWRIGHT_MCP_CONFIG makes it launch Playwright's Chromium; NO_UPDATE_NOTIFIER
#    stops it asking npm for updates on every run. About 220 MiB compressed.
ARG PLAYWRIGHT_CLI=0.1.23
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libfontconfig1 libfreetype6 fonts-liberation fonts-noto-color-emoji fonts-freefont-ttf
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PLAYWRIGHT_MCP_CONFIG=/etc/playwright/cli.config.json \
    NO_UPDATE_NOTIFIER=1
COPY cli.config.json /etc/playwright/cli.config.json
RUN npm install -g --prefix /usr/local --no-audit --no-fund "@playwright/cli@${PLAYWRIGHT_CLI}" \
 && playwright-cli install-browser chromium --only-shell \
 && chmod -R a+rX /opt/ms-playwright \
 && rm -rf /root/.npm /root/.cache /tmp/*

# 5. Where the agent's own installs go: under HOME=/workspace, on the pod's volume. The pod sets
#    HOME at run time, so these paths are literal. New releases wait 3 days before npm, pnpm and
#    uv install them (min-release-age in days, minimumReleaseAge in minutes, exclude-newer): most
#    malicious versions are found and pulled sooner. A task can override one install.
ENV LANG=C.UTF-8 \
    PATH=/workspace/.local/bin:/workspace/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/workspace/.local \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MISE_YES=1 \
    CHECKPOINT_DISABLE=1 \
    MISE_DATA_DIR=/workspace/.local/share/mise \
    MISE_CONFIG_DIR=/workspace/.config/mise \
    MISE_CACHE_DIR=/workspace/.cache/mise \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_min_release_age=3 \
    pnpm_config_minimum_release_age=4320 \
    UV_EXCLUDE_NEWER="3 days"

# 6. What this image holds, for the agent and for tests.
RUN mkdir -p /etc/nylorun \
 && { echo "image: my-computer"; echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"; \
      for t in git python3 pip3 uv node npm mise gcc make jq rg fd curl sqlite3 playwright-cli; do \
        printf '%s: %s\n' "$t" "$("$t" --version 2>&1 | head -1)"; done; \
      echo "browsers: $(ls /opt/ms-playwright | tr '\n' ' ')"; } > /etc/nylorun/image.txt \
 && rm -rf /workspace/.cache /workspace/.config /workspace/.local

USER 1000:1000
WORKDIR /workspace
```

`cli.config.json`, beside the Dockerfile, points the Playwright CLI at that Chromium:

```json
{ "browser": { "browserName": "chromium", "launchOptions": { "headless": true } } }
```

Smoke-test it the way a computer runs it, with no network:

```bash
docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /workspace:uid=1000,gid=1000,exec \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges -e HOME=/workspace my-computer \
  bash -euo pipefail -c 'for t in git python3 uv node npm mise gcc jq rg; do "$t" --version >/dev/null; done; cat /etc/nylorun/image.txt'
```

Rebuild it on a schedule (monthly, and for security fixes), and pin each new digest in the Agent's
`runtime.json`.
