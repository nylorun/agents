# syntax=docker/dockerfile:1
#
# ghcr.io/nylorun/runtime: the Nylorun Runtime. One image runs every service;
# `--service` picks what a container runs: `core,loop` (the default: the APIs and
# the agent loop) or `gates` (the Model Gate). In a container, loop needs the gate
# (NYLORUN_GATES_URL and NYLORUN_GATES_TOKEN). `--role api|worker|all` is a
# deprecated alias. Build from the monorepo root:
#
#   docker build -f runtime/Dockerfile -t nylorun-runtime:dev .
#
# The image keeps the repository layout under /app (runtime/server, runtime/harness,
# core), so the workspace links in node_modules resolve.
#
# The image runs as a non-root user. Compose overrides it with
# `user: "${NYLORUN_UID}:${NYLORUN_GID}"` so files the Runtime writes into the
# bind-mounted Host root belong to the developer. Node and npx stay in the
# image for stdio MCP servers.
#
# tini is installed for sandbox pods (F7.2): they copy /usr/bin/tini-static, node
# and /engine from this image into the pod and run the engine under it as PID 1
# (`tini -g -- node /nylo/engine/harness.mjs --service harness`), so any glibc workload image can host it.
# /engine is the pod's engine bundled into one script plus the one native addon it loads
# (ADR-92 §5): 12 files instead of /app's ~30,000, which every pod start used to copy.

ARG NODE_IMAGE=node:24-bookworm-slim

# Every workspace manifest, so `npm ci` sees the lockfile's workspace layout. Files
# only, so both the build and the target's deps can start from them.
FROM scratch AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY runtime/harness/package.json runtime/harness/
COPY sdks/agents/package.json sdks/agents/
COPY sdks/admin/package.json sdks/admin/
COPY runtime/server/package.json runtime/server/
COPY studio/package.json studio/
COPY cli/nylorun/package.json cli/nylorun/
COPY cli/legacy/package.json cli/legacy/
COPY cli/create-agent/package.json cli/create-agent/

# The build runs on the builder's own platform: it emits only JavaScript (dist), and
# the deps stage installs node_modules, native addons included, for the target.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund \
      --workspace core --workspace runtime/harness --workspace runtime/server
COPY scripts/check-typescript-version.mjs scripts/
COPY scripts/lib/repo.mjs scripts/lib/
COPY core/tsconfig.json core/
COPY core/src core/src
COPY core/scripts core/scripts
COPY runtime/harness/tsconfig.json runtime/harness/
COPY runtime/harness/src runtime/harness/src
COPY runtime/server/tsconfig.json runtime/server/
COPY runtime/server/scripts/build-openapi.mjs runtime/server/scripts/copy-migrations.mjs runtime/server/scripts/bundle-harness.mjs runtime/server/scripts/
COPY runtime/server/src runtime/server/src
RUN npm run build --workspace core \
 && npm run build --workspace runtime/harness \
 && npm run build --workspace runtime/server \
 && node runtime/server/scripts/bundle-harness.mjs /engine

# Install scripts run here: optional native addons (zstd, lzma for the virtual
# shell) fetch prebuilt binaries. When one cannot, npm drops that optional
# dependency and the shell reports the format as unsupported.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
      --workspace core --workspace runtime/harness --workspace runtime/server

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NYLORUN_HOME=/nylorun \
    NYLORUN_LISTEN_HOST=0.0.0.0 \
    NYLORUN_LISTEN_PORT=4000
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /usr/bin/tini-static
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/core/package.json core/
COPY --from=deps /app/runtime/harness/package.json runtime/harness/
COPY --from=deps /app/runtime/server/package.json runtime/server/
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/runtime/harness/dist runtime/harness/dist
COPY --from=build /app/runtime/server/dist runtime/server/dist
# The bundled pod engine and its zstd addon, built for this image's platform (the deps stage).
# npm drops the optional addon where it can't build it; the engine then reports zstd unsupported.
COPY --from=build /engine/harness.mjs /engine/harness.mjs
RUN mkdir -p /engine/node_modules/@mongodb-js \
 && if [ -d node_modules/@mongodb-js/zstd ]; then cp -a node_modules/@mongodb-js/zstd /engine/node_modules/@mongodb-js/; fi
# The Host root is bind-mounted here. It is world-writable only so that an
# arbitrary compose `user:` can start without a mount; the mount replaces it.
RUN mkdir -p /nylorun /workspaces && chmod 1777 /nylorun /workspaces
# The operator command (`docker compose exec runtime nylorun-operate keys put …`).
RUN printf '#!/bin/sh\nexec node /app/runtime/server/dist/host/operate.js "$@"\n' > /usr/local/bin/nylorun-operate \
  && chmod 755 /usr/local/bin/nylorun-operate
USER node
EXPOSE 4000 4100 9080
ENTRYPOINT ["node", "runtime/server/dist/host/main.js"]
CMD ["--service", "core,loop"]
