# My Nylorun agent

Before you start, install the prerequisites once. Nothing downloads them for
you; `npx nylorun@beta doctor` checks them.

- Node 24 or newer.
- Docker with Compose v2: [Docker
  Desktop](https://docs.docker.com/get-started/get-docker/),
  [OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima).
  The local Runtime and Studio run in Docker Compose.

On Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/install): install
Node inside your WSL distribution, enable Docker Desktop's WSL integration, and
keep the project in the Linux filesystem (`~/…`, not `/mnt/c/…`), where file
watching works.

Agent definitions live in `agents/`. The **Runtime** runs your agents and
holds their sessions in its **Tenant**, one per installation; this project
attaches to its own local Tenant through a **Project link**. `src/main.ts`
saves each agent in `agents/index.ts` to the Runtime (`client.saveAgent`) and
exits; no code of yours runs during a session. The project depends only on
`@nylorun/agents`; the `nylorun` package's two commands run with `npx`:

- `nylorun` sets up and runs this project's local Tenant (Runtime and Studio)
  and links the project to it.
- `nylo` talks to a Runtime: its Tenant's status, reset and model provider
  (`npx -p nylorun@beta nylo <command>`).

```sh
npx nylorun@beta start  # this project's Tenant and the link; the first run pulls the images
npm run dev
```

`nylorun start` in this directory sets up the project's Tenant on the first
run (named after the directory, under `~/.nylorun/tenants/<name>/`) and just
starts it after that. It prints the Runtime and Studio URLs; `npx nylorun
studio` signs your browser in to Studio. The Tenant keeps running after you stop `npm run dev`, so sessions survive a source
change; `npx nylorun stop` stops it (volumes are kept), `npx nylorun status`
shows its health, and `npx nylorun logs runtime -f` its logs.

The first `nylorun start` writes `.nylorun/link.json` and
`.nylorun/credentials.json`, and seeds the Tenant's model provider from
`MODEL_PROVIDER`, `MODEL` and `MODEL_PROVIDER_API_KEY` in `.env` (see
`.env.example`). The key is stored in the Tenant vault, never back in `.env`.
Without them, set the provider in Studio's Model provider screen, or with
`npx -p nylorun@beta nylo configure`. Model calls use the Tenant's provider and may
incur its usual charges.

`npm run dev` runs `src/main.ts` with `tsx watch`: it saves the agents to the
Runtime, which it finds through the Project link, and saves them again on
every source edit. `npx nylorun studio` opens Studio on this project's Tenant,
and signs in a browser that is not signed in yet; chat with the assistant
there. The Runtime listens on
`http://localhost:8787` and Studio on `http://localhost:4161`, or on free ports
chosen on the first start.

```sh
npm run build
npm start
```

`npm start` runs `node dist/src/main.js`, the same entry as development: it
saves the agents once, a deploy step. Set `NYLORUN_RUNTIME_URL` and
`NYLORUN_SERVER_KEY` before starting, or keep the Project link beside this
directory. `agents/index.ts` exports the registry. Start a new session after
changing definitions; active-session upgrades are not supported.

The assistant has no tools yet. A tool is an `http()` tool, a request the
Runtime makes to a service of yours (see the comment in
`agents/assistant/agent.ts`), a remote MCP server, or another agent used as a
tool. A code tool (`tool({ run })`) is refused when it is saved: the Runtime
runs no code of yours during a session.

Export the linked Project environment:

```sh
eval "$(npx -p nylorun@beta nylo env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

Project link and credentials live in gitignored `.nylorun/` beside this project.
The Tenant's Host root (`~/.nylorun/tenants/<name>/`, or `NYLORUN_HOME`) holds
its files and the admin key; Tenant data lives in its Docker volumes.
A fresh clone or second worktree does not reuse this link: `npx nylorun start`
there gives it a Tenant of its own, and `npx nylorun start --tenant <name>`
links it to this project's Tenant instead.
Keep `.nylorun/` private. The application key is derived from the Tenant's
admin key when the project is linked. Ordinary
shutdown/restart preserves completed session history; `npx -p nylorun nylo
reset --all` empties the Tenant, and `npx nylorun reset` deletes all its data.
`NYLORUN_IMPLEMENTATION_VERSION` (default `dev`) labels each saved
definition.

This beta supports local text, HTTP tools, remote MCP servers and agents used
as tools; the starter itself wires none of them. Advanced waits, media,
deployment, reconciliation and broad recovery guarantees are deferred.
