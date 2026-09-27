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

Use **Node 24 and npm 11** (CI pins 24.15.0 and 11.15.0; matching majors is enough) on macOS or Linux. On Windows, clone and work inside [WSL2](https://learn.microsoft.com/windows/wsl/install). With nvm:

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

`npm run dev` links the workspace Runtime into `.tmp/runtime-prefix` and puts
its `nylorun-runtime` first on PATH, so contributors need no global
`@nylorun/runtime` and never run a published one by accident.

Studio opens at `http://127.0.0.1:4161`; the Runtime Host listens on port 8787
(or the port in `host.json`). The first run starts the Host, creates or reuses a
Tenant via a Project link under gitignored `examples/.nylorun/`, and stores the
model provider in that Tenant's vault. The Host outlives `npm run dev`; stop it
with `npx nylorun runtime down` and inspect it with
`npx nylorun runtime status`. `npm run configure` replaces that credential while
the Host is running. Advanced examples retain their own historical data paths.
Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

## Development

| Command                                               | Use                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                                         | Supported local example with package rebuilds and Studio   |
| `npm run dev -- --no-open`                            | Keep the browser closed                                    |
| `npm run dev -- --no-studio`                          | Run only the agent server                                  |
| `npm run dev -- --no-autostart`                       | Fail instead of starting a Runtime (use in CI)             |
| `npx nylorun runtime up` / `npx nylorun runtime down` | Start or stop the Runtime Host                             |
| `npx nylorun runtime status`                          | Report Host id, address, protocol and Tenants              |
| `eval "$(npx nylorun runtime status --env)"`          | Export URL, key and Tenant for the linked Project          |
| `npx nylorun runtime logs --follow`                   | Multiplex Host + Tenant logs                               |
| `npm run dev -- --port 4200 --studio-port 4201`       | Choose different ports                                     |
| `npm run dev:starter`                                 | Preview a fresh starter against local packages             |
| `npm run build`                                       | Build all seven packages                                   |
| `npm test`                                            | Run package, tooling, and examples tests after setup       |
| `npm run check`                                       | Build and run the standard repository checks               |
| `npm run check:stack`                                 | Check generated starter contracts and built example assets |

Agent edits restart the development stack. Start a new session after definition
changes. Harness/SDK/Runtime edits rebuild and restart the host. A compile error
leaves the running server available; fixing it resumes rebuilds. Studio edits
rebuild and restart its packaged frontend and server.
Stop development before changing dependencies, then rerun setup.

Starter preview prints a retained directory under `.tmp/` and its provider setup
command. It has its own configuration. Rerun to preview template changes; existing
preview agents and credentials are never overwritten.

For focused checks: `npm run check --workspace @nylorun/runtime` (substitute another
package). CI uses `-- --built` on root checks after setup to avoid rebuilding.

The Runtime and Studio also ship as the images `ghcr.io/nylorun/runtime` and
`ghcr.io/nylorun/studio`, built from the repository root. To run your changes
under `nylorun start`, build them and point the CLI at the local tags:

```sh
docker build --file runtime/Dockerfile --tag nylorun-runtime:dev .
docker build --file studio/Dockerfile --tag nylorun-studio:dev .
NYLORUN_RUNTIME_IMAGE=nylorun-runtime:dev NYLORUN_STUDIO_IMAGE=nylorun-studio:dev npx nylorun start
```

CI's `stack` job does the same with images built from the PR, and `integration`
runs the Runtime's integration tests against the Docker test stack
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
| Missing/stale package build     | Stop development and run `npm run setup`                                                                                                                                        |
| Occupied port                   | The CLI exits 4 and names the port; stop the other service or pass `--port`. First automatic Host setup may pick a free loopback port and persist it in `host.json`             |
| Protocol `426`                  | Upgrade CLI (`nylorun runtime restart`) or pin `@nylorun/cli` / `@nylorun/agents` within the Host protocol range                                                                |
| Quarantined Tenant              | `nylorun tenant status` shows `code` and `repair` (`locked`, `kek-missing`, `corrupt`, `schema-too-new`, `migration-failed`, `envelope-invalid`, `open-timeout`, `open-failed`) |
| Model setup error               | Run `npx nylorun runtime up`, then `npm run configure`, or replace the vault credential from Studio                                                                             |
| Need Host / Tenant logs         | `npx nylorun runtime logs --follow`                                                                                                                                             |
| Generated-file conflict         | Move the intended change into the template/recipe, then sync                                                                                                                    |
| Interrupted release preparation | Inspect the diff; do not blindly rerun or discard it                                                                                                                            |

Contributions are licensed under [Apache-2.0](./LICENSE); no CLA is required.
Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.
