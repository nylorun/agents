---
"nylorun": minor
"@nylorun/cli": minor
"@nylorun/runtime": patch
---

**One command, `nylorun`, grouped by the API each command uses.** `nylo` became part of `nylorun`, and the commands that are not the installation's lifecycle moved into groups: `environments` (the Runtime API, an application key), `tenant` (the Management API, a management key) and `local` (Docker and kubectl on this machine). See MIGRATION.md.

- **`nylorun`:** `up`, `down`, `start`, `stop`, `status`, `studio` and `doctor` stay at the top. `tenant reset|keys|signing-keys|models set|mcp inspect`; `environments list|delete`; `local ls|delete|logs|reset|sandbox|telemetry`; `doctor sandbox`. The old spellings (`nylorun logs`, `reset`, `key`, `mcp`, `sandbox`, `configure`, …) exit 2 naming their replacement.
- **Remote installations:** without `--tenant`, `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY` points `status`, `doctor sandbox` and `tenant` at a remote installation, and with `NYLORUN_SERVER_KEY` points `environments` there. `tenant keys` then manages application keys through the Management API; `tenant mcp inspect` and `environments` no longer need a local Tenant.
- **`nylo`:** for one release, each command exits 2 naming the `nylorun` command that replaced it. `nylo env` has no replacement: the SDKs read the Project link themselves.
- **`@nylorun/cli`:** its `nylo` still runs nylorun's, which now names the replacement.
- **`@nylorun/runtime`:** messages that named `nylo configure`, `nylorun sandbox enable|status` or `nylorun key put` name `nylorun tenant models set`, `nylorun local sandbox enable|status` and `nylorun tenant keys put`.
