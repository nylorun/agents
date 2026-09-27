---
"@nylorun/cli": minor
"@nylorun/studio": minor
"@nylorun/create-agent": minor
---

**The local Runtime and Studio run as a Docker Compose stack that the CLI manages; Studio ships only as its image (breaking beta).**

- `nylorun start` writes `<Host root>/stack/compose.yaml` and `.env` (mode 0600) and starts Postgres, Restate, s2-lite, the Runtime and Studio on loopback ports, with the Runtime and Studio images this CLI pins (`nylorun.runtime`, `nylorun.studio`; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them). `nylorun stop` keeps the volumes; `nylorun status [--json] [--env]` reports services and health; `nylorun reset [--yes]` deletes the volumes and every Tenant.
- `nylorun dev` starts the stack if it is not running, creates the Project's Tenant on first run, opens Studio on that Tenant through a single-use login URL (`next=/tenants/<id>`), and runs the application with `NYLORUN_RUNTIME_URL=http://localhost:<port>`. `--no-open` prints the URL only; `--no-studio` skips Studio. `--local-ui` is removed (exit 2).
- `nylorun logs` and `nylorun studio` are the stack commands (`nylorun stack <command>` still works). `nylorun studio` lands on the linked Project's Tenant.
- `nylorun runtime up|down|restart|run|status|logs` and the `up`/`down` aliases are removed; they exit 2 and name `nylorun start|stop|status|logs`. `nylorun runtime status --env` is now `nylorun status --env`.
- `nylorun doctor` checks Node 24+, Docker, Compose v2 and the stack's health; `doctor runtime` is an alias of it.
- `@nylorun/studio` is private and ships only as `ghcr.io/nylorun/studio`: `startStudio`, the hosted (`local.nylorun.studio`) and local UI modes, pairing, the `nylorun-studio` bin and the UI bundle download are removed.
- `npm create @nylorun/agent` no longer adds `@nylorun/studio` or a `studio` script, checks for Docker with Compose v2 instead of a global `@nylorun/runtime`, and accepts `--no-studio` only as a deprecated no-op.
