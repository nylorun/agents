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
`src/main.ts` saves each agent to the Runtime as an agent manifest
(`client.agentManifests.save`, with the runtime section in
`runtime/scratch.runtime.json`) and makes its Agent (`client.agents.put`, id the
agent's): on every source edit under `npm run dev`, once under `npm start`. No
code of the project runs during a session; the starter's assistant has no
tools, and a comment shows how to add an `http()` tool.

Creation installs the project's dependencies and prints the next steps. If a
prerequisite is missing (Node older than 24, no `docker`, an engine that does
not answer, or Compose older than v2), it says what to set up first. `--yes`
affects installation only. `--no-open` and `--no-studio` are accepted and
ignored: the creator starts nothing and opens no browser.

```sh
cd my-agent
npx nylorun@beta start  # this project's Tenant (Docker) and the link in .nylorun/
npm run dev             # tsx watch src/main.ts: saves the agents, makes their Agents
npx nylorun studio      # a fresh Studio login on this project's Tenant
npm run build
npm start
```

`nylorun start` in the project creates and starts the project's own local
Tenant (Runtime, Studio and their infrastructure in Docker, named after the
directory; `--tenant` picks or shares another). It writes the Project link and the project's keys (an application and a management key) to
gitignored `.nylorun/`, and seeds the model provider from `.env`
(`MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`) into the Tenant vault.
`nylorun status` and `nylorun tenant reset` work on the linked Tenant. Studio or
`npx nylorun tenant models set` sets or replaces the provider.
`npm start` runs `node dist/src/main.js` with the same entry as development.
Without a Project link, set `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY`
before a production start. Tenant data, including the
vault, lives in the Tenant's Docker volumes. Definitions have no model provider or
`agent.run()`.
