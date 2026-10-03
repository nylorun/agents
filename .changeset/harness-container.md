---
"nylorun": minor
---

**The harness container, the network split, and Restate's UI closed by default (F6.2).** A local Tenant now runs agent turns, stdio MCP servers and workspaces in a `harness` container: the runtime image as `--service harness`, connected to the runtime's Harness API (`ws://runtime:4200/nylorun/harness/v1`, `NYLORUN_HARNESS=remote`) with `NYLORUN_HARNESS_TOKEN`, which `nylorun start` generates once and keeps in `.env`. The harness holds no other credential, mounts only the Tenant directory's `sandboxes/`, `plugin-data/`, `home/` and `tmp/` under `/harness`, publishes no port and is healthy once connected; `nylorun status` and `nylorun doctor` report it, and `nylorun logs harness` shows its log. `NYLORUN_HARNESS=in-process` in `.env` rolls back to turns in the runtime container (the harness service is then removed).

- Plugin roots: the Host root's `plugins/` directory is mounted read-only at its own path into the harness and runtime containers, so a stdio MCP server from a plugin under `~/.nylorun/tenants/<name>/plugins/` runs in the harness.
- Networks: `<project>-store` (internal) joins Postgres, s2-lite, Restate and RustFS to the runtime and the gateway only; `<project>-harness` joins the harness to the runtime and the gateway only; the default network keeps egress and the published ports.
- Restate's admin API and UI (unauthenticated) are no longer published. `nylorun start --restate-ui` (or `NYLORUN_RESTATE_UI=1`) publishes them on loopback for that start and prints the URL.
