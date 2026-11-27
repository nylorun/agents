# The service's configuration

Reads the files `nylorun local sandbox enable` writes under `<Host root>/sandboxes/`, mounted read-only at `/run/nylorun/sandboxes`, and the service's environment (`config.go:1-3`). Everything the service needs to reach its cluster comes through here.

## Interface

- `Cluster` (`config.go:24-58`): `cluster.json` — `context`, `server`, `dial`, `tlsServerName`, `caData`, `namespace`, `controllerVersion`, `hostAddress`, `bindAddress`, `ports`, `networkPolicy`, `enabledAt`, `backend`, `substrate`, `inCluster`, `imageMirrors`.
- `Substrate`, `Computer`, `Edge` (`config.go:68`, `config.go:96`, `config.go:117`): the parts of `cluster.json` the Substrate backend adds.
- `NetworkPolicy` (`config.go:134`): what `enable`'s egress probe found.
- `Config` (`config.go:140-154`): the cluster, the listen address, the bearer token, the token file and the computer's agent.
- `Load` (`config.go:190`): the environment and `<dir>/cluster.json` as one `Config`.
- `ParseFlags` (`config.go:163`): `--computer-agent go|engine` and `--computer-image`.
- `DefaultDir` (`config.go:187`), `BackendAgentSandbox`/`BackendSubstrate` (`config.go:63-64`), `ComputerAgentGo`/`ComputerAgentEngine` (`config.go:157-160`).

## Rules

- `NYLORUN_SANDBOXES_TOKEN` is required and at least 32 characters, else `Load` fails (`config.go:195-198`).
- The directory is `NYLORUN_SANDBOXES_DIR`, default `/run/nylorun/sandboxes` (`config.go:191-194`); the token file is `<dir>/token` (`config.go:211`).
- `cluster.json` must name a namespace; a cluster reached by `dial` needs `caData` (or `inCluster`), and `dial` must be `host:port` (`config.go:221-231`).
- `inCluster` needs the `substrate` backend, and that backend needs `atespace`, `systemNamespace`, `apiService` and `serviceAccount` (`config.go:238-243`).
- `--computer-agent go` needs `--computer-image`; anything but `go` or `engine` is refused, as are extra arguments (`config.go:170-181`).

## Side effects

- Reads `<dir>/cluster.json` at startup and no other file (`config.go:203`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
