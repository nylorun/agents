# syntax=docker/dockerfile:1.7
# ghcr.io/nylorun/dev:engine-<runtime>: the dev image (images/dev, ADR-92 in nylorun/factory) plus
# one Runtime version's engine under /opt/nylorun (ADR-99): the Runtime image's tini, node and
# bundled engine, which the sandboxes service runs with entrypoint "builtin", so a pod's wake copies
# nothing in. Built only from published images; nothing is compiled. Nothing else goes in: an agent
# installs what a task needs into its home.
#
#   docker build --build-arg DEV=<dev image by digest> --build-arg RUNTIME_VERSION=<version> images/dev-engine
ARG DEV=scratch
ARG RUNTIME_VERSION=unset
ARG RUNTIME_IMAGE=ghcr.io/nylorun/runtime:${RUNTIME_VERSION}

FROM ${RUNTIME_IMAGE} AS engine

FROM ${DEV}
ARG DEV
ARG RUNTIME_VERSION
LABEL dev.nylorun.engine.version="${RUNTIME_VERSION}" \
      dev.nylorun.base="${DEV}" \
      org.opencontainers.image.source="https://github.com/nylorun/agents" \
      org.opencontainers.image.description="A coding agent's computer with the Runtime's engine built in"
COPY --from=engine /usr/bin/tini-static /opt/nylorun/bin/tini
COPY --from=engine /usr/local/bin/node /opt/nylorun/bin/node
COPY --from=engine /engine /opt/nylorun/engine
COPY <<EOT /opt/nylorun/VERSION
${RUNTIME_VERSION}
EOT
