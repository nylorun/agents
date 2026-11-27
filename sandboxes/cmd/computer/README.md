# The computer agent

The one process of an Agent Substrate actor that is a computer, mounted from `ghcr.io/nylorun/computer` at `/nylo` and run as `/nylo/computer` in place of the engine's `--service computer` (`main.go:1-4`). It serves the computer's routes from `internal/computer`, runs as the actor's PID 1, and stays up on SIGTERM on Substrate, where it means the worker is stopping and the sandboxes service will suspend the actor (`main.go:4-7`).

## Interface

- `main` (`main.go:27`): `computer version` prints the version; anything else starts the agent.
- `run` (`main.go:48`): the configuration, the trust bundle, the actor's name, then the server.

## Rules

- `computer version` prints `computer.Version` and exits (`main.go:28-31`).
- On Substrate the process stays up on SIGTERM instead of stopping (`main.go:4-6`, `config.go:27-29` in `internal/computer`).
- It does the template wrapper's work itself: umask 022, the harness home and workspace created, the working directory set to the workspace (`main.go:53-61`).

## Side effects

- Creates `<NYLORUN_HARNESS_ROOT>/home` and the workspace (`main.go:56-60`).
- Writes the trust bundle where `NYLORUN_COMPUTER_TRUST_FILE` names it (`main.go:63`).
- Reads the actor's name from `NYLORUN_COMPUTER_NAME_FILE` (`main.go:67`).
- Listens on `NYLORUN_COMPUTER_PORT` (`internal/computer/config.go:17`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
