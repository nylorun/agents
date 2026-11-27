# The computer agent

The one process of an Agent Substrate actor that is a computer. It serves the routes of [internal/computer](../../internal/computer/README.md) on `NYLORUN_COMPUTER_PORT`, runs as the actor's PID 1, and stands in for the Runtime engine's `--service computer` with the same tickets and the same answers. It ships alone in `ghcr.io/nylorun/computer`, and the sandboxes service mounts it as the `nylo` image volume and starts `/nylo/computer`.

## Interface

- `main` (`main.go`): `computer version` prints `computer.Version`; anything else calls `run`.
- `run` (`main.go`): loads the config, makes the workspace directories, writes the trust bundle, starts the HTTP server and waits on it or on a signal.
- `logLine` (`main.go`): one JSON line `{level, message, time, …fields}`, in the shape the engine's host logger writes.

## Rules

- `version` prints the version and exits before any config is read (`main.go`).
- The config comes from `computer.LoadConfig`: `NYLORUN_COMPUTER_PORT` (default 8080), the ticket public key, the actor's name file, `NYLORUN_HARNESS_ROOT` (`/harness`), the egress CA file, the trust file, the workspace, and `NYLORUN_SANDBOX_SUBSTRATE` (`main.go`).
- SIGTERM with `NYLORUN_SANDBOX_SUBSTRATE=1` logs `computer_worker_stopping` and keeps serving: on Substrate that signal means the worker is stopping and the sandboxes service suspends the actor; any other signal closes the server (`main.go`).
- umask is 022, `<harness root>/home` and the workspace are created, and the process changes to the workspace (`main.go`).
- The server sets `ReadHeaderTimeout` 30 s and `IdleTimeout` 5 min, and no read or write timeout, because an attach waits up to 50 s and a file is as long as it is (`main.go`).
- The actor's name is the trimmed contents of `NYLORUN_COMPUTER_NAME_FILE`; a file that can't be read stops the process (`main.go`).

## Side effects

- Creates `<harness root>/home` and the workspace directory (`main.go`).
- Writes the trust bundle (`NYLORUN_COMPUTER_TRUST_FILE`, default `/tmp/nylorun-trust.pem`) and sets the trust variables for the commands it runs (`main.go`).
- Reads the egress CA file and the ticket key at start (`main.go`, `computer.TrustEnvironment`).
- Listens on `0.0.0.0:<port>` (`main.go`).
- Runs commands and writes files in the workspace and the harness root, through `internal/computer`.

## Verification

- Run: `go test ./...` (from `sandboxes/`)
