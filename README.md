# Nylorun Agents

Observable, portable, composable TypeScript agent execution. Harness is
state-in/state-out; the optional **Runtime Host** owns sessions for the one
**Tenant** of its installation.

This repository contains core (definitions/contracts), harness (engine), agents
(SDK), admin (Management API client), runtime (OSS Host), CLI, Studio and the project
creator. Cloud lives in the private agents-api repository. Vocabulary:
[runtime/src/CONTEXT.md](runtime/src/CONTEXT.md).

The Runtime runs as a container next to Postgres (the Session Store), Restate
(Durable Session Execution) and S2 (Durable Streams, `s2-lite` locally). Studio,
the dashboard, runs beside them. Each installation has its own database and
serves one Tenant. On a developer machine `nylorun start` runs all five with
Docker Compose: one local Tenant per project, or the default Tenant outside a
project.

For the core-runtime beta, start with [the SDK](agents/README.md),
[Runtime Host](runtime/README.md), and [host contract](harness/HOST_CONTRACT.md).

> **Experimental beta.** Public APIs may change before 1.0. Prefer the `@beta`
> dist-tag for installs until then.

## Quick start

Install the prerequisites once: Node.js 24 or newer, and Docker with Compose v2
([Docker Desktop](https://docs.docker.com/get-started/get-docker/),
[OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima)).
The local Runtime and Studio run in Docker Compose. Nylorun runs on
macOS and Linux; on Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/install) with Docker
Desktop's WSL integration (native Windows is not supported).

```sh
node --version             # 24 or newer
docker compose version     # v2
```

Create a local agent project:

```sh
npm create @nylorun/agent@beta my-agent
```

The creator installs the project's dependencies and prints the next steps. If
a prerequisite is missing, it says what to set up; nothing is downloaded for
you. Then:

```sh
cd my-agent
npx nylorun@beta start   # this project's Tenant (Docker) and the link in .nylorun/
npm run dev              # tsx watch src/main.ts
```

`--yes` (after `--`) accepts npm install prompts.

The generated app depends on `@nylorun/agents` alone; the two tools run with
`npx`. `nylorun` sets up and runs the project's local **Tenant**: its
Runtime, Studio and services in Docker Compose, under
`~/.nylorun/tenants/<name>/`, named after the project directory
(`nylorun start|stop|status|logs|studio|reset`, `nylorun ls` and
`nylorun delete <tenant>`; `nylorun doctor` checks the prerequisites).
`nylorun start` writes the **Project link** under `.nylorun/` and seeds the
model provider from `.env` into the Tenant's vault (or set it in Studio).
Projects that must not share agents, credentials or history run separate
Tenants; `nylorun start --tenant <name>` (or `NYLORUN_TENANT`) attaches a
checkout to an existing one. Outside a project, `nylorun start` runs the
Tenant `default`.
`@nylorun/cli`, command `nylo`, is the Runtime client for the linked
installation (`nylo status|reset|endpoints|configure|access`). Studio runs in
the Tenant's containers as the `ghcr.io/nylorun/studio` image.

## Develop this repository

Requires **Node 24** and **npm 11**. See [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
git clone https://github.com/nylorun/agents.git
cd agents
npm run setup
npm run dev
```

`npm run setup` installs both lockfiles and builds packages. `npm run dev`
builds the Runtime and Studio images from your checkout, runs the examples'
Tenant on them (`nylorun start`), and runs the examples on that Tenant, rebuilding
packages and images as you edit. The Tenant keeps running after you stop `dev`,
so sessions survive a source change; `npx nylorun down` stops it.

Print the export lines for a linked Project:

```sh
eval "$(npx @nylorun/cli env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

## Packages

| Package                                   | Role                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| [`@nylorun/core`](./core)                 | Shared definitions, contracts and manifest identity               |
| [`@nylorun/harness`](./harness)           | Execution engine and checkpoints                                  |
| [`nylorun`](./nylorun)                    | `npx nylorun start`: a project's local Tenant and its link        |
| [`@nylorun/cli`](./cli)                   | Runtime client (`nylo`): status, reset, access, model provider    |
| [`@nylorun/agents`](./agents)             | Session SDK and authoring: define agents and save them           |
| [`@nylorun/admin`](./admin)               | Management API client: models, vaults, MCP server previews, signing keys, application keys |
| [`@nylorun/runtime`](./runtime)           | Runtime Host and Tenant Runtime; the `ghcr.io/nylorun/runtime` image |
| [`@nylorun/studio`](./studio)             | Dashboard and trusted proxy; the `ghcr.io/nylorun/studio` image   |
| [`@nylorun/create-agent`](./create-agent) | Project scaffolding, compatibility pins, and examples sync        |
| [`examples`](./examples)                  | Authored capability demonstrations on the generated project shell |

## Documentation

| Doc                                                  | Audience                                        |
| ---------------------------------------------------- | ----------------------------------------------- |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                 | Contributors — setup, checks, workflow          |
| [RELEASING.md](./RELEASING.md)                       | Maintainers — version, publish, dist-tags       |
| [MIGRATION.md](./MIGRATION.md)                       | Breaking beta migration (incl. Runtime V1)      |
| [DEPLOYMENT.md](./DEPLOYMENT.md)                     | Application hosting                             |
| [SELF_HOSTING.md](./SELF_HOSTING.md)                 | Teams — your own identity provider and secrets  |
| [agents/README.md](./agents/README.md)               | Authoring agents against a Tenant               |
| [SECURITY.md](./SECURITY.md)                         | Vulnerability reports                           |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)           | Community standards                             |

Package-level READMEs: [Harness](./harness/README.md) · [Runtime](./runtime/README.md) · [CLI](./cli/README.md) · [Admin](./admin/README.md) · [Studio](./studio/README.md) · [Examples](./examples/README.md)

## License

[Apache-2.0](./LICENSE)
