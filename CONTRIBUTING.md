# Contributing

## Repository map

| Directory       | Responsibility                                          |
| --------------- | ------------------------------------------------------- |
| `core/`         | Shared definitions and contracts                        |
| `harness/`      | Agent execution engine                                  |
| `nylorun/`      | `nylorun`: sets up and runs the local Docker stack      |
| `cli/`          | `nylo`: the Runtime client (Tenants, Project link)      |
| `runtime/`      | Runtime Host, execution and persistence (runtime image) |
| `studio/`       | Studio server and dashboard (the `studio` stack image)  |
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

Setup installs both lockfiles and builds packages. The eight packages compile with the TypeScript 7 native compiler; `typescript` is aliased to the TypeScript 6 bridge for scripts that use the compiler API. It does not configure models,
regenerate examples, or change local credentials/data. Package consumer Node
support remains separate from the pinned contributor toolchain.

`npm run dev` is the contributor loop on the local Docker stack:

1. It builds the host packages, then the Runtime and Studio images from your
   checkout (`nylorun-runtime:dev`, `nylorun-studio:dev`; unchanged layers come
   from Docker's cache).
2. It runs `nylorun start` on those images. The stack lives in `NYLORUN_HOME`
   (default `~/.nylorun`) as Compose project `nylorun`, and outlives
   `npm run dev`.
3. It links `examples/` to its Tenant once (`nylo tenant create`, the Project
   link in the git-ignored `examples/.nylorun/`), signs the browser in to Studio
   on that Tenant (`nylorun studio`; `--no-open` prints a single-use login URL
   instead), and
   starts the examples' Action endpoint with their own `npm run dev` (`tsx watch`).
4. It watches `core`, `harness`, `agents`, `admin`, `runtime`, `nylorun`, `cli`
   and `studio`. An edit rebuilds that package and the packages that depend on it,
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
| `eval "$(npx nylo env)"` (in `examples/`)   | Export URL, key and Tenant for the linked Project                          |
| `npx nylorun down` / `npx nylorun reset`    | Stop the stack (volumes kept) / delete its volumes and Tenants             |
| `npm run build`                             | Build all eight packages                                                   |
| `npm test`                                  | Run package, tooling, and examples tests after setup (needs Docker)        |
| `npm run check`                             | Build and run the standard repository checks                               |
| `npm run check:stack`                       | Check generated starter contracts and built example assets                 |
| `npm run test:stack`                        | Smoke `nylorun up`/`down` on a temporary stack                             |
| `npm run test:starter`                      | Smoke the packed starter (`nylorun up`, `nylo tenant create`, `npm run dev`, a temporary fixture-model Tenant) on a temporary stack |
| `npm run test:dev`                          | Smoke `npm run dev` on a temporary stack and a clean copy of `examples/`   |
| `npm run test:acceptance [-- --only H1,H2]` | Tenant acceptance (H1–H9) on a temporary stack                             |

The stack smokes (`scripts/lib/stack.mjs`) build `nylorun-runtime:local`
and `nylorun-studio:local` from the checkout, or reuse the images
`NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` name. Each runs under a
temporary `NYLORUN_HOME` with its own Compose project and always ends with
`nylorun reset --yes`, so it never touches `~/.nylorun` or a running dev stack.

Starter preview prints a retained directory under `.tmp/`. It has its own
Project link and configuration. Rerun to preview template changes; existing
preview agents and credentials are never overwritten.

For focused checks: `npm run check --workspace @nylorun/runtime` (substitute another
package). CI uses `-- --built` on root checks after setup to avoid rebuilding.

The Runtime's tests keep every Tenant in Postgres: each test file gets its own database,
cloned from a template the run migrates, on the Docker test stack
(`runtime/test/stack/compose.yaml`: Postgres, Restate, s2-lite). `npm test` in `runtime/`
starts that stack when its Postgres does not answer, and leaves it running for the next
run; the examples' tests use it too. Manage it yourself with
`npm run test:stack:up --workspace @nylorun/runtime` and `npm run test:stack:down
--workspace @nylorun/runtime`; set `NYLORUN_TEST_STACK_EXTERNAL=1` to make the tests fail
instead of starting it, and the `NYLORUN_TEST_*_PORT` variables to move its ports.

The Runtime and Studio ship as the images `ghcr.io/nylorun/runtime` and
`ghcr.io/nylorun/studio`, built from the repository root. To run your changes
under `nylorun up` without `npm run dev`, build them and point `nylorun` at the
local tags:

```sh
docker build --file runtime/Dockerfile --tag nylorun-runtime:dev .
docker build --file studio/Dockerfile --tag nylorun-studio:dev .
NYLORUN_RUNTIME_IMAGE=nylorun-runtime:dev NYLORUN_STUDIO_IMAGE=nylorun-studio:dev npx nylorun start
```

CI builds both images from the PR for the `stack`, `smoke-starter`, `smoke-dev`
and `acceptance` jobs. `check` and `consumers` start the Docker test stack before
their tests, and `integration` runs the Runtime's integration tests against it
(`npm run test:stack:up --workspace @nylorun/runtime`, then
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
| Protocol `426`                  | Upgrade `nylorun` and run `nylorun up` (nylorun pins the Runtime image), or pin `@nylorun/agents` within the Runtime's protocol range                                          |
| Quarantined Tenant              | `nylo tenant status` shows `code` and `repair` (`kek-missing`, `corrupt`, `schema-too-new`, `migration-failed`, `envelope-invalid`, `open-timeout`, `open-failed`)              |
| Model setup error               | Run `npx nylorun up`, then `npm run configure` (`nylo configure`), or replace the vault credential from Studio                                                                 |
| Need Runtime / Studio logs      | `npx nylorun logs -f` (or `npx nylorun logs runtime`)                                                                                                                           |
| Generated-file conflict         | Move the intended change into the template/recipe, then sync                                                                                                                    |
| Interrupted release preparation | Inspect the diff; do not blindly rerun or discard it                                                                                                                            |

Contributions are licensed under [Apache-2.0](./LICENSE); no CLA is required.
Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.
