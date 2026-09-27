# syntax=docker/dockerfile:1
#
# ghcr.io/nylorun/runtime: the Nylorun Runtime, one process with
# `--role api|worker|all`. Build from the monorepo root:
#
#   docker build -f runtime/Dockerfile -t nylorun-runtime:dev .
#
# The image runs as a non-root user. Compose overrides it with
# `user: "${NYLORUN_UID}:${NYLORUN_GID}"` so files the Runtime writes into the
# bind-mounted Host root belong to the developer. Node and npx stay in the
# image for stdio MCP servers.

ARG NODE_IMAGE=node:24-bookworm-slim

# Every workspace manifest, so `npm ci` sees the lockfile's workspace layout.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY harness/package.json harness/
COPY agents/package.json agents/
COPY admin/package.json admin/
COPY runtime/package.json runtime/
COPY studio/package.json studio/
COPY cli/package.json cli/
COPY create-agent/package.json create-agent/

FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund \
      --workspace core --workspace harness --workspace runtime
COPY scripts/check-typescript-version.mjs scripts/
COPY scripts/lib/repo.mjs scripts/lib/
COPY core/tsconfig.json core/
COPY core/src core/src
COPY harness/tsconfig.json harness/
COPY harness/src harness/src
COPY runtime/tsconfig.json runtime/
COPY runtime/src runtime/src
RUN npm run build --workspace core \
 && npm run build --workspace harness \
 && npm run build --workspace runtime

# Install scripts run here: optional native addons (zstd, lzma for the virtual
# shell) fetch prebuilt binaries. When one cannot, npm drops that optional
# dependency and the shell reports the format as unsupported.
FROM manifests AS deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
      --workspace core --workspace harness --workspace runtime

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NYLORUN_HOME=/nylorun \
    NYLORUN_LISTEN_HOST=0.0.0.0 \
    NYLORUN_LISTEN_PORT=4000
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/core/package.json core/
COPY --from=deps /app/harness/package.json harness/
COPY --from=deps /app/runtime/package.json runtime/
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/harness/dist harness/dist
COPY --from=build /app/runtime/dist runtime/dist
# The Host root is bind-mounted here. It is world-writable only so that an
# arbitrary compose `user:` can start without a mount; the mount replaces it.
RUN mkdir -p /nylorun /workspaces && chmod 1777 /nylorun /workspaces
USER node
EXPOSE 4000 9080
ENTRYPOINT ["node", "runtime/dist/host/main.js"]
CMD ["--role", "all"]
