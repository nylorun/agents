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

Agent and tool definitions live in `agents/`. The **Runtime** holds your
sessions in its **Tenant**, one per installation; this project attaches to
its own local Tenant through a **Project link**. Your tools run in this app: `src/main.ts` serves them as an **Action
endpoint** (`createActionHandler`) on `http://localhost:3001/nylorun/actions`
and registers that URL, and the Runtime delivers each tool call there, signed.
The project depends only on `@nylorun/agents`; the two Nylorun tools run with
`npx`:

- `nylorun` sets up and runs this project's local Tenant (Runtime and Studio)
  and links the project to it.
- `@nylorun/cli` (command `nylo`) talks to a Runtime: its Tenant's status,
  reset, Action endpoints and model provider.

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
`npx @nylorun/cli configure`. Model calls use the Tenant's provider and may
incur its usual charges.

`npm run dev` runs `src/main.ts` with `tsx watch`: it serves the Action
endpoint on port 3001 (`PORT` changes it) and registers it with the Runtime,
which it finds through the Project link. The local Runtime runs in
Docker and reaches `localhost` on this machine. `npx @nylorun/cli endpoints`
shows the endpoint and how its deliveries are doing. `npx nylorun studio` opens Studio on this
project's Tenant, and signs in a browser that is not signed in yet. In
Studio, ask **Look up order demo-123**. The local tool returns `shipped`;
Studio shows the tool call and assistant response. The Runtime listens on
`http://localhost:8787` and Studio on `http://localhost:4161`, or on free ports
chosen on the first start.

```sh
npm run build
npm start
```

`npm start` runs `node dist/src/main.js`, the same entry as development. Set
`NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY` before
starting, or keep the Project link beside this directory, and set
`NYLORUN_ACTIONS_URL` to the URL the Runtime reaches this app at (a public URL,
or a tunnel such as ngrok for a remote Runtime). `agents/index.ts` exports the
registry. A source edit restarts the app, which re-registers the agents and
the endpoint; the Runtime is untouched. Start a new session
after changing definitions or implementations; active-session upgrades are not
supported.

Export the linked Project environment:

```sh
eval "$(npx @nylorun/cli@beta env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

Project link and credentials live in gitignored `.nylorun/` beside this project.
The Tenant's Host root (`~/.nylorun/tenants/<name>/`, or `NYLORUN_HOME`) holds
its files and the admin key; Tenant data lives in its Docker volumes.
A fresh clone or second worktree does not reuse this link: `npx nylorun start`
there gives it a Tenant of its own, and `npx nylorun start --tenant <name>`
links it to this project's Tenant instead.
Keep `.nylorun/` private. The application key is derived from the Tenant's
admin key when the project is linked. Each delivery carries a short-lived
token the endpoint verifies with the Tenant's public keys. Ordinary
shutdown/restart preserves completed session history; `npx @nylorun/cli reset
--all` empties the Tenant, and `npx nylorun reset` deletes all its data.
`NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`; assign an explicit version
when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP,
deployment, reconciliation and broad recovery guarantees are deferred.
Subagents are supported in the SDK and examples (`agents used as tools`); the
starter itself does not wire them.
