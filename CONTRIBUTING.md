# Contributing

## Repository map

| Directory       | Responsibility                                          |
| --------------- | ------------------------------------------------------- |
| `core/`         | Shared definitions and contracts                        |
| `harness/`      | Agent execution engine                                  |
| `cli/`          | Local `nylorun` orchestration                           |
| `runtime/`      | Providers, hosting and persistence                      |
| `studio/`       | Dashboard and programmatic startup                      |
| `create-agent/` | Starter, renderer, compatibility pins, and stack tests  |
| `examples/`     | Generated application shell and authored demonstrations |
| `scripts/`      | Repository development, validation, and release tooling |

Harness and Runtime must not depend on each other. Studio depends on neither.
Cross-package contracts are tested in the creator. Examples remains a separate
npm project with its own lockfile.

## First run

Use **Node 24 and npm 11** (CI pins 24.15.0 and 11.15.0; matching majors is enough) on macOS or Linux, and **Docker with Compose v2** (Docker Desktop, OrbStack, Colima or another engine). On Windows, clone and work inside [WSL2](https://learn.microsoft.com/windows/wsl/install). With nvm:

```sh
nvm install
nvm use
npm install --global npm@11.15.0
npm run setup
npm run dev
```

Setup installs both lockfiles and builds packages. The seven packages compile with the TypeScript 7 native compiler; `typescript` is aliased to the TypeScript 6 bridge for scripts that use the compiler API. It does not configure models,
regenerate examples, or change local credentials/data. Package consumer Node
support remains separate from the pinned contributor toolchain.

`npm run dev` is the contributor loop on the local Docker stack:

1. It builds the host packages, then the Runtime and Studio images from your
   checkout (`nylorun-runtime:dev`, `nylorun-studio:dev`; unchanged layers come
   from Docker's cache).
2. It runs `nylorun start` on those images. The stack lives in `NYLORUN_HOME`
   (default `~/.nylorun`) as Compose project `nylorun`, and outlives
   `npm run dev`.
3. It runs `nylorun dev` in `examples/`. That creates or reuses the examples
   Tenant through the Project link in the git-ignored `examples/.nylorun/`,
   starts the examples executor under `tsx watch`, and prints a single-use
   Studio login URL for that Tenant (and opens it unless `--no-open`).
4. It watches `core`, `harness`, `agents`, `admin`, `runtime`, `cli` and
   `studio`. An edit rebuilds that package and the packages that depend on it,
   rebuilds the images built from them (Compose then recreates only those
   containers), and restarts the examples runner. A compile error keeps the
   stack and the runner as they were; fixing it resumes rebuilds.

Agent edits in `examples/` restart the application through `tsx watch`; start a
new session after definition changes. Stop development before changing
dependencies, then rerun setup. The examples model provider lives in the
Tenant's vault: run `npm run configure` (or replace it from Studio).
Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

To keep the dev stack apart from another one on the same machine, set
`NYLORUN_HOME` (and `NYLORUN_STACK_PROJECT` for the Compose project name). Set
`NYLORUN_RUNTIME_IMAGE` or `NYLORUN_STUDIO_IMAGE` to run an image you built
yourself; `npm run dev` then neither builds nor rebuilds that image.

## Development

| Command                                     | Use                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                               | The examples on the stack, with package and image rebuilds                 |
| `npm run dev -- --no-open`                  | Keep the browser closed                                                    |
| `npm run dev -- --no-studio`                | Start the stack without Studio                                             |
| `npm run dev -- --no-watch`                 | Build and start once; no rebuilds                                          |
| `npm run dev:starter`                       | The same loop on a fresh starter preview under `.tmp/`                     |
| `npx nylorun studio` (in `examples/`)       | A fresh Studio login on the examples Tenant                                |
| `npx nylorun status` / `npx nylorun logs`   | Stack services, endpoints and health; aggregated logs (`-f`, `<service>`)  |
| `eval "$(npx nylorun status --env)"`        | Export URL, key and Tenant for the linked Project                          |
| `npx nylorun stop` / `npx nylorun reset`    | Stop the stack (volumes kept) / delete its volumes and Tenants             |
| `npm run build`                             | Build all seven packages                                                   |
| `npm test`                                  | Run package, tooling, and examples tests after setup                       |
| `npm run check`                             | Build and run the standard repository checks                               |
| `npm run check:stack`                       | Check generated starter contracts and built example assets                 |
| `npm run test:stack`                        | Smoke `nylorun start` on a temporary stack                                 |
| `npm run test:starter`                      | Smoke the packed starter with `nylorun dev` on a temporary stack           |
| `npm run test:dev`                          | Smoke `npm run dev` on a temporary stack                                   |
| `npm run test:acceptance [-- --only H1,H2]` | Tenant acceptance (H1–H9) on a temporary stack                             |

The four stack smokes (`scripts/lib/stack.mjs`) build `nylorun-runtime:local`
and `nylorun-studio:local` from the checkout, or reuse the images
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` name. Each runs under a
temporary `NYLORUN_HOME` with its own Compose project and always ends with
`nylorun reset --yes`, so it never touches `~/.nylorun` or a running dev stack.

Starter preview prints a retained directory under `.tmp/`. It has its own
Project link and configuration. Rerun to preview template changes; existing
preview agents and credentials are never overwritten.

For focused checks: `npm run check --workspace @nylorun/runtime` (substitute another
package). CI uses `-- --built` on root checks after setup to avoid rebuilding.

The Runtime and Studio ship as the images `ghcr.io/nylorun/runtime` and
`ghcr.io/nylorun/studio`, built from the repository root. To run your changes
under `nylorun start` without `npm run dev`, build them and point the CLI at the
local tags:

```sh
docker build --file runtime/Dockerfile --tag nylorun-runtime:dev .
docker build --file studio/Dockerfile --tag nylorun-studio:dev .
NYLORUN_RUNTIME_IMAGE=nylorun-runtime:dev NYLORUN_STUDIO_IMAGE=nylorun-studio:dev npx nylorun start
```

CI builds both images from the PR for the `stack`, `smoke-starter`, `smoke-dev`
and `acceptance` jobs, and `integration` runs the Runtime's integration tests
against the Docker test stack (`npm run test:stack:up --workspace @nylorun/runtime`, then
`NYLORUN_TEST_STACK=1 npm run test:integration --workspace @nylorun/runtime`).
Releases publish both images; see [RELEASING.md](./RELEASING.md).

## Generated examples and dependencies

Edit starter files or the examples recipe, then:

```sh
npm run examples:sync
npm install --prefix examples
npm run examples:check
```

Review the generated diff and lockfile. Never hand-edit files owned by
`examples/.scaffold-manifest.json`. Agent demonstrations, tests, scripts, and local
state are authored or local; synchronization does not overwrite them.
Use `npm install` explicitly when changing dependencies, committing the affected
lockfile. Routine setup uses `npm ci` and never refreshes lockfiles.

## Pull requests

Keep changes focused and test observable behavior. For a package release, add a
short change description with `npm run changeset`; select the affected packages
and version impact. Repository-only changes do not require package releases.
Run `npm run check`; run `npm run check:stack` for packaging or cross-package changes.
See [RELEASING.md](./RELEASING.md) for administrators and
[DEPLOYMENT.md](./DEPLOYMENT.md) for application hosting.

| Problem                         | Action                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain mismatch              | Use Node 24 and npm 11; setup prints the detected versions                                                                                                                      |
| Docker missing or not running   | Start Docker Desktop, OrbStack or Colima; `npx nylorun doctor` reports what is missing                                                                                          |
| Missing/stale package build     | Stop development and run `npm run setup`                                                                                                                                        |
| Occupied port                   | The first `nylorun start` picks free loopback ports and keeps them in `<Host root>/stack/.env`; edit that file, or free the port, if another service takes one later          |
| Protocol `426`                  | Upgrade `@nylorun/cli` and run `nylorun start` (the CLI pins the Runtime image), or pin `@nylorun/cli` / `@nylorun/agents` within the Runtime's protocol range                  |
| Quarantined Tenant              | `nylorun tenant status` shows `code` and `repair` (`kek-missing`, `corrupt`, `schema-too-new`, `migration-failed`, `envelope-invalid`, `open-timeout`, `open-failed`)           |
| Model setup error               | Run `npx nylorun start`, then `npm run configure`, or replace the vault credential from Studio                                                                                  |
| Need Runtime / Studio logs      | `npx nylorun logs -f` (or `npx nylorun logs runtime`)                                                                                                                           |
| Generated-file conflict         | Move the intended change into the template/recipe, then sync                                                                                                                    |
| Interrupted release preparation | Inspect the diff; do not blindly rerun or discard it                                                                                                                            |

Contributions are licensed under [Apache-2.0](./LICENSE); no CLA is required.
Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.
