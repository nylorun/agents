# Nylorun Harness

Observable, portable, composable TypeScript agent execution. Harness is
state-in/state-out; the optional **Runtime Host** owns sessions across isolated
**Tenants**.

This repository contains core (definitions/contracts), harness (engine), agents
(SDK), admin (Admin API client), runtime (OSS Host), CLI, Studio and the project
creator. Cloud lives in the private agents-api repository. Vocabulary:
[runtime/src/CONTEXT.md](runtime/src/CONTEXT.md).

The Runtime runs as a container next to Postgres (the Session Store), Restate
(Durable Session Execution) and S2 (Durable Streams, `s2-lite` locally). Studio,
the dashboard, is a service of the same stack. On a developer machine
`nylorun start` runs all five with Docker Compose.

For the core-runtime beta, start with [the SDK](agents/README.md),
[Runtime Host](runtime/README.md), and [host contract](harness/HOST_CONTRACT.md).

> **Experimental beta.** Public APIs may change before 1.0. Prefer the `@beta`
> dist-tag for installs until then.

## Quick start

Install the prerequisites once: Node.js 24 or newer, and Docker with Compose v2
([Docker Desktop](https://docs.docker.com/get-started/get-docker/),
[OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima)).
The local Runtime and Studio run as a Docker Compose stack. Nylorun runs on
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

The creator installs dependencies and starts development. If a prerequisite
is missing, it stops after creating the project and prints what to set up;
nothing is downloaded for you. The first start pulls and starts the local stack
(`nylorun start`), creates a **Tenant** for the project, writes a **Project
link** under `.nylorun/`, opens Studio on that Tenant, and asks for a model
provider, whose credential it stores in the Tenant's vault.

Useful flags (after `--`):

| Flag          | Effect                                      |
| ------------- | ------------------------------------------- |
| `--no-open`   | Start development without opening a browser |
| `--yes`       | Accept npm install prompts                  |

The generated app depends on the SDK and, for development, the CLI. The
`@nylorun/cli` package provides `nylorun`, which runs the local stack
(`nylorun start|stop|status|logs|studio|reset`; `nylorun doctor` checks the
prerequisites). Studio ships in the stack as the `ghcr.io/nylorun/studio`
image.

## Develop this repository

Requires **Node 24** and **npm 11**. See [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm run setup
npm run dev
```

`npm run setup` installs both lockfiles and builds packages. `npm run dev`
builds the Runtime and Studio images from your checkout, runs the stack on them
(`nylorun start`), and runs the examples on their own Tenant, rebuilding
packages and images as you edit. The stack keeps running after you stop `dev`,
so sessions survive a source change; `npx nylorun stop` stops it.

Print the three export lines for a linked Project:

```sh
eval "$(npx nylorun status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Packages

| Package                                   | Role                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| [`@nylorun/core`](./core)                 | Shared definitions, contracts and manifest identity               |
| [`@nylorun/harness`](./harness)           | Execution engine and checkpoints                                  |
| [`@nylorun/cli`](./cli)                   | Local Docker stack, Project link and `nylorun dev`                |
| [`@nylorun/agents`](./agents)             | Session SDK, authoring and authenticated SSE customer executor    |
| [`@nylorun/admin`](./admin)               | Admin API client: Tenants and Host status                         |
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
| [agents/README.md](./agents/README.md)               | Authoring agents against a Tenant               |
| [SECURITY.md](./SECURITY.md)                         | Vulnerability reports                           |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)           | Community standards                             |

Package-level READMEs: [Harness](./harness/README.md) · [Runtime](./runtime/README.md) · [CLI](./cli/README.md) · [Admin](./admin/README.md) · [Studio](./studio/README.md) · [Examples](./examples/README.md)

## License

[Apache-2.0](./LICENSE)
