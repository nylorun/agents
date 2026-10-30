# syntax=docker/dockerfile:1
#
# ghcr.io/nylorun/dev: a coding agent's computer (ADR-92 in nylorun/factory). Ubuntu 24.04 with
# the base toolchain only: git, Python, Node, a C toolchain and the installers the agent uses for
# everything else (mise, uv, npm). Nylorun's engine is not in it: the pod copies the engine in, as
# for any image. Released on its own schedule, not the Runtime's: every new digest is a cold pull
# on every node. Build from this folder:
#
#   docker build -t nylorun-dev:local images/dev
#
# The pod runs it as uid 1000 (`ubuntu`) on a read-only root, with HOME=/workspace on the pod's
# volume. So nothing installs into the image at run time: every installer below writes under
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

# 4. Where the agent's own installs go: under HOME=/workspace, on the pod's volume. The pod sets
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

# 5. What this image holds, for the agent and for tests.
RUN mkdir -p /etc/nylorun \
 && { echo "image: ghcr.io/nylorun/dev"; echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"; \
      for t in git python3 pip3 uv node npm mise gcc make jq rg fd curl sqlite3; do \
        printf '%s: %s\n' "$t" "$("$t" --version 2>&1 | head -1)"; done; } > /etc/nylorun/image.txt \
 && rm -rf /workspace/.cache /workspace/.config /workspace/.local

USER 1000:1000
WORKDIR /workspace
