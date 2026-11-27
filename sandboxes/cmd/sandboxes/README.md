# The sandboxes service

The service the Runtime's core calls to run a Tenant's sandboxes: it holds the cluster credentials, serves the HTTP API of [internal/api](../../internal/api/README.md), and drives one of the two backends (agent-sandbox's Sandboxes, or Agent Substrate's actors) with the same `/v1/pods` contract. The same binary carries the service's side commands: `healthcheck` for the image's health check, `edge-cert` and `substrate-setup` for `nylorun local sandbox enable`, and `provider` and `gateway` for the Substrate backend's keys provider and sandbox gateway. It is built into `ghcr.io/nylorun/sandboxes`.

## Interface

- `main` (`main.go`): dispatches on the first argument: `healthcheck`, `edge-cert <host> <dir>`, `provider`, `gateway`, `substrate-setup`, or the service itself.
- `run` (`main.go`): loads the config, parses `--computer-agent` and `--computer-image`, builds the backend, and serves the API until a signal.
- `healthcheck` (`main.go`): `GET http://127.0.0.1:<port>/ready` with a 4 s timeout; exit 0 when it answers 200, else 1. The port is `NYLORUN_SANDBOXES_LISTEN`'s (default `:4300`).
- `substrateBackend` (`main.go`): dials Substrate, returns the Substrate driver and the edge that runs beside the API.
- `edgeFront` (`main.go`): reads `edge-ca.pem`, `edge.crt` and `edge.key` from the config directory and builds the edge's routes.
- `substrateSetup` (`main.go`): makes the Tenant's atespace and its editor binding, then exits.
- `runProvider` (`main.go`): serves the keys provider's `FetchSecret` over mutual TLS and `/readyz`, with flags `--listen` (`:50051`), `--health` (`:9091`), `--name`, `--server-cred-bundle`, `--client-ca-file`, `--injector-identity`, `--config`, `--budget`.
- `runGateway` (`main.go`): serves the sandbox gateway, with flags `--listen` (`:4400`), `--atespace`, `--computer-port` (8080), `--ticket-key`, `--router`, `--router-name`, `--credential-bundle`, `--router-ca`.

## Rules

- `healthcheck` needs `NYLORUN_SANDBOXES_LISTEN` to be `host:port` and treats any answer but 200 as not ready (`main.go`).
- `edge-cert` takes exactly two arguments, `<host> <dir>`, and writes the CA and certificate through `edge.WriteCert` (`main.go`).
- `substrate-setup` needs `NYLORUN_SUBSTRATE_OWNER_TOKEN` or the file `NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE` names, and refuses a `cluster.json` whose backend is not `substrate` (`main.go`).
- The editor principal `substrate-setup` binds is `user:system:serviceaccount:<namespace>:<serviceAccount>` (`main.go`).
- The service's API server sets `ReadHeaderTimeout` 5 s, `ReadTimeout` 15 s, `WriteTimeout` `api.MaxWait + 30 s` and `IdleTimeout` 90 s (`main.go`).
- `provider --listen` serves gRPC, `/readyz` answers 503 until the config file and the certificate bundle both exist (`main.go`).
- `--atespace` (or `NYLORUN_SUBSTRATE_ATESPACE`) is required by `gateway`, which loads the ticket key from `--ticket-key` before listening (`main.go`).
- `--computer-agent go` needs `--computer-image`; any value but `go` or `engine` is refused by `config.Config.ParseFlags` (`main.go`, `internal/config`).

## Side effects

- Reads `<NYLORUN_SANDBOXES_DIR>/cluster.json`, `token`, `edge-ca.pem`, `edge.crt` and `edge.key` (`main.go`).
- Calls the Kubernetes dynamic client (agent-sandbox backend) or dials Substrate's API and watches worker pods (Substrate backend) (`main.go`).
- Listens on the API address, and on the Substrate backend on the edge's ports: `:8443` to `http://runtime:4200`, `:8444` to `http://gateway:4100`, and `:8445` to `http://gateway:4200` when the config has a keys port; each address and upstream is an environment variable (`main.go`).
- Makes the atespace and its access policy through Substrate's API in `substrate-setup` (`main.go`).
- Writes nothing else: no state, and no file, outside `edge-cert`.

## Verification

- Run: `go test ./...` (from `sandboxes/`)
