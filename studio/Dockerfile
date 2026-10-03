# ghcr.io/nylorun/studio: the dashboard and the trusted proxy on one origin.
#
# Build from the repository root (the build context is the monorepo):
#   docker build -f studio/Dockerfile -t nylorun-studio:dev .
#
# Runtime environment (see studio/src/server-main.ts):
#   NYLORUN_RUNTIME_URL            e.g. http://runtime:4000 (required)
#   NYLORUN_ADMIN_KEY_FILE         host-credentials.json, mounted read-only (required)
#   PORT                           listen port, default 3000
#   NYLORUN_STUDIO_PUBLIC_PORT     published loopback port the browser uses
#   NYLORUN_STUDIO_SESSION_COOKIE  session cookie name, default nylorun_studio_session
#
# No HEALTHCHECK: Compose orders services with depends_on. GET /healthz answers
# for probes that want one.

ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# Every workspace manifest, so npm ci can read the lockfile.
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY harness/package.json harness/
COPY agents/package.json agents/
COPY admin/package.json admin/
COPY runtime/package.json runtime/
COPY studio/package.json studio/
COPY nylorun/package.json nylorun/
COPY cli/package.json cli/
COPY create-agent/package.json create-agent/
RUN npm ci --ignore-scripts \
      -w @nylorun/core -w @nylorun/agents -w @nylorun/admin -w @nylorun/studio
COPY scripts scripts
COPY core core
COPY agents agents
COPY admin admin
COPY studio studio
RUN npm run build -w @nylorun/core \
 && npm run build -w @nylorun/agents \
 && npm run build -w @nylorun/admin \
 && npm run build -w @nylorun/studio

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/core/package.json core/
COPY --from=build /repo/harness/package.json harness/
COPY --from=build /repo/agents/package.json agents/
COPY --from=build /repo/admin/package.json admin/
COPY --from=build /repo/runtime/package.json runtime/
COPY --from=build /repo/studio/package.json studio/
COPY --from=build /repo/cli/package.json cli/
COPY --from=build /repo/create-agent/package.json create-agent/
RUN npm ci --omit=dev --ignore-scripts -w @nylorun/studio \
 && npm cache clean --force

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY --from=build /repo/core/package.json core/
COPY --from=build /repo/core/dist core/dist
COPY --from=build /repo/agents/package.json agents/
COPY --from=build /repo/agents/dist agents/dist
COPY --from=build /repo/admin/package.json admin/
COPY --from=build /repo/admin/dist admin/dist
COPY --from=build /repo/studio/package.json studio/
COPY --from=build /repo/studio/dist studio/dist
USER node
EXPOSE 3000
CMD ["node", "studio/dist/server-main.js"]
