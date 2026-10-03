# @nylorun/create-agent

Install the prerequisites first (the creator checks them and never installs
them): Node 24 or newer, and Docker with Compose v2 ([Docker
Desktop](https://docs.docker.com/get-started/get-docker/),
[OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima)).
The local Runtime and Studio run in Docker Compose, which `nylorun`
manages. On Windows, work inside
[WSL2](https://learn.microsoft.com/windows/wsl/install) with Docker Desktop's WSL
integration; native Windows is not supported.

```sh
node --version                     # 24 or newer
docker compose version             # v2
npm create @nylorun/agent@beta my-agent
```

Creates a Node 24 project whose only Nylorun dependency is `@nylorun/agents`
(plus Zod). The registry in `agents/index.ts` exports agent definitions.
`src/main.ts` serves the agents' tools with `createActionHandler` and registers
its URL, for both `npm run dev` and `npm start`. The
starter includes one ordinary `lookup_order` tool; ask “Look up order
demo-123”.

Creation installs the project's dependencies and prints the next steps. If a
prerequisite is missing (Node older than 24, no `docker`, an engine that does
not answer, or Compose older than v2), it says what to set up first. `--yes`
affects installation only. `--no-open` and `--no-studio` are accepted and
ignored: the creator starts nothing and opens no browser.

```sh
cd my-agent
npx nylorun@beta start  # this project's Tenant (Docker) and the link in .nylorun/
npm run dev             # tsx watch src/main.ts
npx nylorun studio      # a fresh Studio login on this project's Tenant
npm run build
npm start
```

`nylorun start` in the project creates and starts the project's own local
Tenant (Runtime, Studio and their infrastructure in Docker, named after the
directory; `--tenant` picks or shares another). It writes the Project link and the derived application credentials to
gitignored `.nylorun/`, and seeds the model provider from `.env`
(`MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`) into the Tenant vault.
`@nylorun/cli` (command `nylo`) is the Runtime client: `nylo status`,
`nylo reset` and `nylo endpoints` work on the linked Tenant. Studio or
`npx @nylorun/cli configure` sets or replaces the provider.
`npm start` runs `node dist/src/main.js` with the same entry as development.
Export the Project environment (`eval "$(npx @nylorun/cli env)"`) before a
production start when there is no Project link. Tenant data, including the
vault, lives in the Tenant's Docker volumes. Definitions have no model provider or
`agent.run()`.

`starter/` is the canonical template. `compatibility.json` pins core, harness,
agents, admin, Runtime and CLI. `nylorun` pins the Runtime and Studio images
it runs (`nylorun/package.json` `nylorun`). The examples recipe adds local
package dependencies. Run `npm run examples:sync` after template changes, then
`npm install --prefix examples`. Sync preserves authored agents, tests,
credentials, and local state; it rejects conflicting edits to generated files.

The default examples registry contains the release starter. Advanced examples
remain outside that registry for later migration.

`npm run test:starter` (`create-agent/scripts/smoke-starter.mjs`) packs the
workspace, scaffolds the starter from the packed creator, installs `nylorun`
and `@nylorun/cli` beside it (never into it), runs `nylorun start` in it and
`npm run dev` against a temporary local Tenant, then resets that Tenant,
seeds the fixture model and runs one turn that calls the starter's
tool.

See [RELEASING](../RELEASING.md) for the Changesets beta workflow. Nothing is
published by the smoke check.
