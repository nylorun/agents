# @nylorun/create-agent

Install the prerequisites first (the creator checks them and never installs
them): Node 24 or newer, and Docker with Compose v2 ([Docker
Desktop](https://docs.docker.com/get-started/get-docker/),
[OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima)).
The local Runtime and Studio run as a Docker Compose stack that `nylorun`
manages. On Windows, work inside
[WSL2](https://learn.microsoft.com/windows/wsl/install) with Docker Desktop's WSL
integration; native Windows is not supported.

```sh
node --version                     # 24 or newer
docker compose version             # v2
npm create @nylorun/agent@beta my-agent
```

Creates a Node 24 project with `@nylorun/agents` and Zod in production, plus
`@nylorun/cli` as a development tool. The registry in `agents/index.ts` exports
agent definitions. `src/main.ts` calls `connectAgents` for both `npm run dev`
and `npm start`. The starter includes one ordinary `lookup_order` tool; ask
“Look up order demo-123”.

Creation installs dependencies and starts development. If a prerequisite is
missing (Node older than 24, no `docker`, an engine that does not answer, or
Compose older than v2), it stops after creating the project and prints what to
set up. Use `--no-open` to suppress browser opening. `--no-studio` is
deprecated and ignored: Studio is part of the stack, so projects no longer
depend on `@nylorun/studio`. `--yes` affects installation only. The first
`nylorun dev` starts the local stack, creates the project's Tenant, opens
Studio on it, and asks for the model provider when the terminal is interactive,
storing the credential in the Tenant vault. A non-interactive start without a
credential exits and names that setup. `NYLORUN_DEV_MODEL=fixture` skips it.

```sh
cd my-agent
npm run dev
npx nylorun studio     # a fresh Studio login on this project's Tenant
npm run build
npm start
```

`npm start` runs `node dist/src/main.js` with the same entry as development.
Export the Project environment (`eval "$(npx nylorun status --env)"`) before a
production start when there is no Project link. Studio can replace an API-key
credential. `nylorun configure` replaces the credential against the running
Runtime. The Project link and application credentials are stored in gitignored
`.nylorun/`; Tenant data, including the vault, lives in the stack. Definitions
have no model provider or `agent.run()`.

`starter/` is the canonical template. `compatibility.json` pins core, harness,
agents, admin, Runtime and CLI (its `studio` entry is kept for the release
tooling; generated projects do not use it). The examples recipe adds local
package dependencies. Run `npm run examples:sync` after template changes, then
`npm install --prefix examples`. Sync preserves authored agents, tests,
credentials, and local state; it rejects conflicting edits to generated files.

The default examples registry contains the release starter. Advanced examples
remain outside that registry for later migration.

`npm run test:starter` (`create-agent/scripts/smoke-starter.mjs`) packs the
workspace, scaffolds the starter from the packed creator and runs
`nylorun dev` against a temporary local Docker stack.

See [RELEASING](../RELEASING.md) for the Changesets beta workflow. Nothing is
published by the smoke check.
