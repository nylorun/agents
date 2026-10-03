# syntax=docker/dockerfile:1
#
# ghcr.io/nylorun/sandboxes: the sandboxes service (D32), versioned with the Runtime.
# A static Go binary on distroless; it holds the cluster credentials and drives
# agent-sandbox Sandboxes for the Runtime's core. Build from the monorepo root:
#
#   docker build -f sandboxes/Dockerfile -t nylorun-sandboxes:dev .
#
# Compose runs it as the developer's UID:GID so it can read the 0600 token in
# <Host root>/sandboxes; the image's own user is distroless's nonroot.

ARG GO_IMAGE=golang:1.26-bookworm

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY sandboxes/go.mod sandboxes/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY sandboxes/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/sandboxes ./cmd/sandboxes

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/sandboxes /sandboxes
EXPOSE 4300
USER nonroot:nonroot
HEALTHCHECK --interval=5s --timeout=5s --retries=3 CMD ["/sandboxes", "healthcheck"]
ENTRYPOINT ["/sandboxes"]
