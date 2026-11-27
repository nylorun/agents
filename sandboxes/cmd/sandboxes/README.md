# The sandboxes service

Nylorun's sandboxes service: the only holder of the cluster credentials, running the Tenant's sandboxes for the Runtime's core, as agent-sandbox Sandboxes or as Agent Substrate actors (`main.go:1-8`). The binary carries the service and the side processes the Substrate backend needs.

## Interface

- `main` (`main.go:44`): dispatches on the first argument.
- `healthcheck` (`main.go:88`): probes `/ready` on `NYLORUN_SANDBOXES_LISTEN` (default `:4300`) for the Compose and image health check.
- `edge-cert` (`main.go:49-60`): writes the edge's CA and certificate for a host into a directory.
- `provider` (`main.go:366`): the keys provider, `internal/provider`.
- `gateway` (`main.go:423`): the sandbox gateway, `internal/gateway`.
- `substrate-setup` (`main.go:313`): makes the Tenant's atespace and its editor binding, once, as one of Substrate's owners.
- Default (no argument): the service — `config.Load`, the backend, the API, the edge and the drain (`main.go:119`).

## Rules

- `healthcheck` exits 1 when `/ready` is not 200, and 0 when it is (`main.go:98-108`).
- `edge-cert` needs exactly `<host> <dir>`, else usage and exit 2 (`main.go:51-54`).
- The provider's one-fetch budget defaults under the egress gateway's 5 s (`main.go:375`, `internal/provider/provider.go:48`).
- The gateway's router address and the name its certificate is checked against are separate flags (`main.go:429-430`).
- `substrate-setup` keeps the atespace's other bindings and adds its principal as editor (`internal/substrate/setup.go:23-24`).

## Side effects

- Listens on `:4300` for core, and on the edge's addresses when the Substrate backend runs (`main.go:91`, `README.md:238`).
- Serves gRPC `:50051` and `/readyz` on `:9091` as the provider, and `:4400` as the gateway (`main.go:368-369`, `main.go:425`).
- Talks to the Kubernetes API server with the Tenant's ServiceAccount token, or to Substrate over gRPC (`internal/config/config.go:211`, `internal/substrate/conn.go:42-49`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
