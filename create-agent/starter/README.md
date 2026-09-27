# My Nylorun agent

Before you start, install the prerequisites once. Nothing downloads them for
you; `npx nylorun@beta doctor` checks them.

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
Production entry is `src/main.ts`, which calls `connectAgents`. The project
depends only on `@nylorun/agents`; the two Nylorun tools run with `npx`:

- `nylorun` sets up and runs the local stack (Runtime and Studio).
- `@nylorun/cli` (command `nylo`) talks to a Runtime: Tenants, the Project
  link and the model provider.

```sh
npx nylorun@beta up                  # the local stack; the first run pulls the images
npx @nylorun/cli@beta tenant create  # this project's Tenant, linked in .nylorun/
npm run dev
```

`nylorun up` sets up the stack under `~/.nylorun` on the first run and just
starts it after that. It prints the Runtime URL and a Studio login URL. The
stack keeps running after you stop `npm run dev`, so sessions survive a source
change; `npx nylorun down` stops it (volumes are kept), `npx nylorun status`
shows its health, and `npx nylorun logs runtime -f` its logs.

`tenant create` creates this project's Tenant, writes `.nylorun/link.json` and
`.nylorun/credentials.json`, and seeds the Tenant's model provider from
`MODEL_PROVIDER`, `MODEL` and `MODEL_PROVIDER_API_KEY` in `.env` (see
`.env.example`). The key is stored in the Tenant vault, never back in `.env`.
Without them, set the provider in Studio's Model provider screen, or with
`npx @nylorun/cli configure`. Model calls use the Tenant's provider and may
incur its usual charges.

`npm run dev` runs `src/main.ts` with `tsx watch`; `connectAgents` finds the
Runtime through the Project link. `npx nylorun studio` opens a fresh Studio
login on this project's Tenant (a login URL works once, for two minutes). In
Studio, ask **Look up order demo-123**. The local tool returns `shipped`;
Studio shows the tool call and assistant response. The Runtime listens on
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
eval "$(npx @nylorun/cli@beta env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Project link and credentials live in gitignored `.nylorun/` beside this project.
The Host root (`NYLORUN_HOME` or `~/.nylorun`) holds the stack's files and the
admin key; Tenant data lives in the stack's Docker volumes. A fresh clone or
second worktree does not reuse this link: run `tenant create` there, or
`npx @nylorun/cli tenant use <name>` with that Tenant's credentials.
Keep `.nylorun/` private. Application credentials are generated when the
Tenant is created; executor tokens are derived at start. Ordinary
shutdown/restart preserves completed session history; `npx nylorun reset`
deletes every Tenant.
`NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`; assign an explicit version
when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP,
deployment, reconciliation and broad recovery guarantees are deferred.
Subagents are supported in the SDK and examples (`agents used as tools`); the
starter itself does not wire them.
