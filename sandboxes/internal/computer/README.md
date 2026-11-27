# A computer's routes

The routes and rules of a sandbox computer: run a command, read and write files, list a directory, and move the workspace and harness root about as disk versions. The package is what the computer agent (`cmd/computer`) serves in an actor; its answers are the engine's `--service computer` answers, held together by the contract file `testdata/contract.json`.

## Interface

- `New(Options) *Server` (`computer.go`): the HTTP handler; `Version` is the build's version (`-ldflags`).
- Routes (`computer.go`): `GET /ready` (no ticket), and with `X-Nylorun-Ticket`: `GET /v1/activity`, `GET /v1/info`, `POST /v1/exec`, `POST /v1/exec/{id}/attach`, `POST /v1/exec/{id}/cancel`, `GET`/`PUT /v1/files`, `GET /v1/list`, `POST /v1/disk`.
- `MaxWait` (`computer.go`): 50 s, the most one request waits for a command.
- `Keep` (`computer.go`): 10 minutes a finished command's result is kept.
- `Workspace` (`computer.go`): `/workspace`.
- `Runner`, `ExecRequest`, `Result` (`exec.go`): the command runner and its shapes (`command`, `cwd`, `timeoutMs`, `env`; `exitCode`, `stdout`, `stderr`, `killed`, `timedOut`).
- `StreamBytes` (`exec.go`): 4 MiB kept from each stream.
- `CommandShell`, `BaseEnv`, `BaselineFrom` (`exec.go`): the shell (`bash`, else `/bin/sh`) and the command's environment.
- `TooLargeError`, `Entry`, `Listing` (`files.go`): the file shapes: `413 too_large`, a directory's entries, and a listing that says `truncated`.
- `LoadConfig(getenv)` (`config.go`): the agent's settings, from `NYLORUN_COMPUTER_PORT` (8080), the ticket public key, the name file, `NYLORUN_HARNESS_ROOT` (`/harness`), the egress CA file, `NYLORUN_SANDBOX_SUBSTRATE`, `NYLORUN_COMPUTER_WORKSPACE` (`/workspace`), the trust file.
- `ParsePublic` (`config.go`): the ticket key from PEM.
- `TrustEnvironment`, `TrustVariables`, `SystemRootFiles`, `DefaultTrustFile` (`trust.go`): the CA bundle the commands trust (`/tmp/nylorun-trust.pem`).

## Rules

- Every route but `/ready` needs a ticket for this computer's name: a missing, expired or foreign one is `401 unauthorized` with `Ticket refused: <reason>`; repeated headers are joined with `", "` as Node does (`computer.go`, `serve`; `ticket.Check`).
- `/ready` answers 503 `not_ready` unless the workspace is writable (`computer.go`).
- `POST /v1/exec` needs `id`, `command` and `timeoutMs`, else `400 invalid_request`; `waitMs` is capped by `MaxWait` (`computer.go`, `exec.go`).
- A command over its timeout is killed with its process group and exits 124; a cancel exits 130 (`exec.go`).
- Each stream keeps its first `StreamBytes` (4 MiB) and notes the bytes dropped (`exec.go`).
- A result is kept `Keep` (10 minutes); a later request for the same id attaches to a running command or reads the kept result (`computer.go`, `exec.go`).
- A body over its limit is `413 too_large` (`files.go`).
- `/v1/disk` names only the `workspace` and `harness` roots; a path out of them is `400 invalid_request`, and the engine's own files (`volume-id`, `egress-ca-bundle.pem`, `setup.json`, `sandboxes`) are never exposed (`disk.go`).
- `LoadConfig` refuses to start when a Runtime credential is in the environment: `NYLORUN_DATABASE_URL`, `NYLORUN_GATES_TOKEN`, `NYLORUN_KEYS_URL`, `NYLORUN_HARNESS_TOKEN`, `NYLORUN_JOIN_TOKEN` (`config.go`).
- Reads and writes answer with the errno names and messages a Node process gives, not Go's (`errors.go`).
- Numbers and strings in a request are converted as JavaScript's `Number()` and `String()` do (`js.go`).

## Side effects

- Runs commands as child processes of the agent, in their own process group, and reaps them: the agent is PID 1 in an actor (`exec.go`, `reaper`).
- Writes, reads and clears files under the workspace and the harness root (`files.go`, `disk.go`).
- Writes the trust bundle and the variables the commands read (`trust.go`).

## Verification

- Run: `go test ./...` (from `sandboxes/`); the contract test in `testdata/contract.json` is shared with the engine's `computerHandler`.
