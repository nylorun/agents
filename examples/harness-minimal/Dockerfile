# syntax=docker/dockerfile:1
#
# The minimal harness as an image: a harness container beside the Runtime, or the entrypoint of
# a sandbox pod. It builds @nylorun/core from this checkout, so build from the repository root:
#
#   docker build -f examples/harness-minimal/Dockerfile -t harness-minimal:dev .
#
# Outside this repository, depend on the published @nylorun/core instead and build from the
# package's own directory with only the last two stages.
#
# It runs as uid 1000 and writes only to HOME (/harness/home), /harness, /workspace and /tmp,
# so it runs on a read-only root as a pod does.

ARG NODE_IMAGE=node:24-bookworm-slim

# @nylorun/core, built as the Runtime image builds it.
FROM ${NODE_IMAGE} AS core
WORKDIR /repo
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
# runtime/harness brings the TypeScript 7 compiler the workspace builds with.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund --workspace core --workspace runtime/harness
COPY scripts/check-typescript-version.mjs scripts/
COPY scripts/lib/repo.mjs scripts/lib/
COPY core/tsconfig.json core/
COPY core/scripts core/scripts
COPY core/src core/src
RUN npm run build --workspace core

# The harness, with core installed as a copy (the package's files and its dependencies).
FROM ${NODE_IMAGE} AS build
WORKDIR /app/examples/harness-minimal
COPY --from=core /repo/core/package.json /app/core/
COPY --from=core /repo/core/dist /app/core/dist
RUN cd /app/core && npm pkg delete scripts devDependencies
COPY examples/harness-minimal/package.json examples/harness-minimal/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --install-links --no-audit --no-fund
COPY examples/harness-minimal/tsconfig.json ./
COPY examples/harness-minimal/src src
RUN --mount=type=cache,target=/root/.npm \
    npm run build && rm -rf node_modules && npm install --omit=dev --install-links --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOME=/harness/home \
    NYLORUN_HARNESS_ROOT=/harness
WORKDIR /app
COPY --from=build /app/examples/harness-minimal/package.json ./
COPY --from=build /app/examples/harness-minimal/node_modules node_modules
COPY --from=build /app/examples/harness-minimal/dist dist
RUN mkdir -p /harness/home /workspace && chown -R 1000:1000 /harness /workspace
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/main.js"]
