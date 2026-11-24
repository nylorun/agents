# syntax=docker/dockerfile:1
#
# ghcr.io/nylorun/computer: the computer agent, one static file at /computer.
# A computer's template mounts this image at /nylo, as an image volume, and runs /nylo/computer in
# the Agent's own image (any Linux image with /bin/sh). It is versioned by its protocol, not with
# the Runtime: a new tag is a new template for new computers only. Build from the monorepo root:
#
#   docker build -f images/computer/Dockerfile --build-arg VERSION=1.0 -t nylorun-computer:dev .

ARG GO_IMAGE=golang:1.27-bookworm

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY sandboxes/ ./
# The agent needs only the standard library and the module's own packages: nothing to download.
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X github.com/nylorun/agents/sandboxes/internal/computer.Version=${VERSION}" \
      -o /out/computer ./cmd/computer

FROM scratch
COPY --from=build --chmod=0755 /out/computer /computer
ENTRYPOINT ["/computer"]
