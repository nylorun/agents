# The computer agent

What runs in an Agent Substrate actor that is a computer, in place of the engine's `--service computer`. It serves the same routes, with the same tickets and the same answers as the Runtime's engine, and the contract test holds both to that (`computer.go:1-4`).

## Interface

- Routes (`computer.go:6-16`): `GET /ready`, `GET /v1/activity`, `GET /v1/info`, `POST /v1/exec`, `POST /v1/exec/{id}/attach`, `POST /v1/exec/{id}/cancel`, `GET`/`PUT /v1/files?path=`, `GET /v1/list?dir=&maxEntries=`, `POST /v1/disk` (`computer.go:138-249`).
- `Config`, `LoadConfig` (`config.go:16-35`, `config.go:45`): the variables a computer's template carries.
- `Runner`, `ExecRequest`, `Result`, `StreamBytes` (`exec.go:40-48`, `exec.go:19-25`, `exec.go:28-35`, `exec.go:16`): how a command runs and what it answers.
- `TrustVariables`, `SystemRootFiles`, `DefaultTrustFile`, `TrustEnvironment` (`trust.go:10`, `trust.go:22`, `trust.go:33`, `trust.go:42`): the bundle CLIs read their roots from.
- `TooLargeError` (`files.go:11`), `Entry`, `Listing` (`files.go:65-78`): a file read that is over its limit, and a directory listing.
- `Version` (`computer.go:42`): what `computer version` prints.

## Rules

- `GET /ready` needs no ticket and is 200 while the workspace is writable; every other route needs `X-Nylorun-Ticket`, else `401 unauthorized` (`computer.go:6-8`).
- A command's `waitMs` is at most 50 s; a result is kept 10 minutes after the command ends (`computer.go:11-13`).
- A file read over `maxBytes` is `413 too_large` (`computer.go:14`, `files.go:11`).
- A timeout kills the command's process group with SIGKILL and answers 124, a cancel 130 (`exec.go:37-39`).
- Each output stream keeps at most 4 MiB, from the head (`exec.go:14-16`).
- A computer must hold none of `NYLORUN_DATABASE_URL`, `NYLORUN_GATES_TOKEN`, `NYLORUN_KEYS_URL`, `NYLORUN_HARNESS_TOKEN`, `NYLORUN_JOIN_TOKEN`: `LoadConfig` refuses to start when one is set (`config.go:37-39`).
- A disk path's first segment names its root, `workspace` or `harness`; the engine's own files under `harness/` (`volume-id`, `egress-ca-bundle.pem`, `setup.json`, `sandboxes`) are never listed, read, written or cleared (`disk.go:19-27`).

## Side effects

- Runs commands as child processes in the workspace (`exec.go:37-39`).
- Writes, reads and clears files under the workspace and `HarnessRoot` (`disk.go:38-44`).
- Writes the trust bundle to `DefaultTrustFile` and returns the variables that name it (`trust.go:33`, `trust.go:42`).
- Reads its configuration from the environment (`config.go:45`).

## Verification

- Run: `go test ./...` from `sandboxes/` (`go.mod`)
