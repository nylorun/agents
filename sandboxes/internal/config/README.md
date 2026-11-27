# The service's configuration

Reads the files `nylorun local sandbox enable` writes under `<Host root>/sandboxes/` and the service's environment, and validates them before anything dials a cluster. One `Cluster` serves either backend: the agent-sandbox fields, or the `substrate` object that replaces them and turns every sandbox into a computer.

## Interface

- `Load(getenv) (Config, error)` (`config.go`): the environment plus `<NYLORUN_SANDBOXES_DIR>/cluster.json` (default `/run/nylorun/sandboxes`).
- `ParseCluster(raw) (Cluster, error)` (`config.go`): decodes and validates `cluster.json`, and fills `Mirrors`.
- `Cluster` (`config.go`): `context`, `server`, `dial`, `tlsServerName`, `caData`, `namespace`, `controllerVersion`, `hostAddress`, `bindAddress`, `ports`, `networkPolicy`, `enabledAt`, `backend`, `substrate`, `inCluster`, `imageMirrors`.
- `Substrate`, `Edge`, `Computer`, `Ports`, `NetworkPolicy` (`config.go`): `atespace`, `systemNamespace`, `apiService`, `endpoint`, `serviceAccount`, `version`, `edge`, `computer`, `workerSelector`, `keysProvider`; the edge's `host`, `harnessPort`, `gatesPort`, `keysPort`.
- `Config` (`config.go`): `Cluster`, `Listen`, `Token`, `TokenFile`, `ComputerAgent`, `ComputerImage`.
- `(*Config).ParseFlags(args)` (`config.go`): `--computer-agent go|engine` and `--computer-image`.
- `(Config).Rest()` (`config.go`): the client-go configuration, in-cluster or from `dial`, `tlsServerName` and `caData`.
- `(Cluster).EdgeURLs()`, `(Cluster).PodURLs()` (`config.go`): the edge's `https://` URLs for actors, and the `http://` URLs a pod uses on the Docker host.
- `(*Substrate).ComputerPort()` (`config.go`): the computer's port, `DefaultComputerPort` (8080) when unset, 0 when sandboxes are not computers.
- `DefaultDir` (`config.go`): `/run/nylorun/sandboxes`.
- `BackendAgentSandbox`, `BackendSubstrate` (`config.go`): `agent-sandbox` and `substrate`.
- `ComputerAgentGo`, `ComputerAgentEngine` (`config.go`): `go` and `engine`.

## Rules

- `NYLORUN_SANDBOXES_TOKEN` is required and must be at least 32 characters (`Load`).
- `cluster.json` needs a `namespace`; outside a cluster it also needs `dial` as `host:port` and base64 `caData` (`ParseCluster`).
- `inCluster` needs `backend: substrate`; an absent backend is `agent-sandbox` (`ParseCluster`).
- `backend: substrate` needs `substrate.atespace`, `systemNamespace`, `apiService` and `serviceAccount`, and either `edge.host` with `harnessPort` and `gatesPort` or `substrate.computer` (`ParseCluster`).
- Any backend but `agent-sandbox` and `substrate` is refused (`ParseCluster`).
- `imageMirrors` is validated by `driver.NewMirrors`: one mirror per repository, no repository mapped to itself or twice (`ParseCluster`).
- `--computer-agent go` needs `--computer-image`; any value but `go` and `engine` is refused (`ParseFlags`).
- The listen address defaults to `:4300` (`Load`).

## Side effects

- Reads `<NYLORUN_SANDBOXES_DIR>/cluster.json` and names `<NYLORUN_SANDBOXES_DIR>/token` as the API server's token file (`Load`).
- Reads `NYLORUN_SANDBOXES_TOKEN`, `_DIR` and `_LISTEN` (`Load`).
- Writes nothing (`config.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`)
