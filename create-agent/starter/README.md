# My Nylorun agent

Before you start, install the prerequisites once. Nothing downloads them for
you; `npx nylorun doctor` checks them.

- Node 24 or newer.
- Docker with Compose v2: [Docker
  Desktop](https://docs.docker.com/get-started/get-docker/),
  [OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima).
  The local Runtime and Studio run as a Docker Compose stack.

On Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/install): install
Node inside your WSL distribution, enable Docker Desktop's WSL integration, and
keep the project in the Linux filesystem (`~/…`, not `/mnt/c/…`), where file
watching works.

Agent and tool definitions live in `agents/`. The **Runtime** holds your
sessions in isolated **Tenants**; this project attaches through a **Project
link** and connects your tools through the SDK's authenticated SSE executor.
Production entry is `src/main.ts`, which calls `connectAgents`.

```sh
npm run dev
```

The first run starts the local stack (`npx nylorun start`; the first start
pulls the images), creates this project's Tenant, writes `.nylorun/link.json`
and `.nylorun/credentials.json`, opens Studio on the Tenant, and asks for a
model provider (stored in that Tenant's vault). **The stack keeps running after
you stop `dev`, so sessions survive a source change.** `npx nylorun stop` stops
it; `npx nylorun status` shows its health, and `npx nylorun logs runtime -f`
its logs. Later runs reuse the link. In Studio, ask **Look up order
demo-123**. The local tool returns `shipped`; Studio shows the tool call and
assistant response. Model calls use the Tenant's saved provider and may incur
its usual charges. Studio's Model provider screen can replace an API key.
`npx nylorun configure` does the same from a terminal.

`npm run dev -- --no-open` prints the Studio login URL without opening a
browser; `--no-studio` skips Studio. `npm run dev -- --ephemeral` runs the
project on a temporary Tenant with a fixture model instead (no provider key;
it answers the order lookup deterministically), and deletes that Tenant when
you stop it. The login URL works once, for two minutes;
`npx nylorun studio` opens a fresh one. The Runtime listens on
`http://localhost:8787` and Studio on `http://localhost:4161`, or on free ports
chosen on the first start.

```sh
npm run build
npm start
```

`npm start` runs `node dist/src/main.js`, the same `connectAgents` entry as
development. Set `NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT`, and
`NYLORUN_SERVER_KEY` before starting, or keep the Project link beside this
directory. `agents/index.ts` exports the registry. A source edit re-registers
agents and reconnects executors; the Runtime is untouched. Start a new session
after changing definitions or implementations; active-session upgrades are not
supported.

Export the linked Project environment:

```sh
eval "$(npx nylorun status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Project link and credentials live in gitignored `.nylorun/` beside this project.
The Host root (`NYLORUN_HOME` or `~/.nylorun`) holds the stack's files and the
admin key; Tenant data lives in the stack's Docker volumes. A fresh clone or
second worktree does not reuse this link until you create or choose one.
Keep `.nylorun/` private. Application credentials are generated automatically;
executor tokens are derived at start. The model provider key is encrypted in the
Tenant vault and kept out of browser configuration and `.env`. Ordinary
shutdown/restart preserves completed session history; `npx nylorun reset`
deletes every Tenant.
`NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`; assign an explicit version
when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP,
deployment, reconciliation and broad recovery guarantees are deferred.
Subagents are supported in the SDK and examples (`agents used as tools`); the
starter itself does not wire them. `NYLORUN_DEV_MODEL=fixture` skips model
setup for release checks; use `--ephemeral` for a credential-free run.
