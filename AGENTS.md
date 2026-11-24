# nylorun/agents — agent guidance

> The open-source Nylorun engine: the Runtime, its harness, the SDKs, the CLI and Studio.

This file describes this repo as it is: what each folder holds, the commands, and the rules to keep
when changing it. Setup and the contributor loop are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Map

| Folder | Holds |
| --- | --- |
| `core/` | `@nylorun/core`: shared definitions, contracts, manifest identity, agent folders, and the Runtime's own Agent Plugins (`core/plugins/`) |
| `runtime/` | The runtime image (`runtime/Dockerfile`): the `runtime`, `gateway` and `harness` containers |
| `runtime/server/` | `@nylorun/runtime`: the Runtime Host, execution and persistence. Session Store migrations are in `src/store/postgres/drizzle/` |
| `runtime/harness/` | `@nylorun/harness`: the agent execution engine. `HOST_CONTRACT.md` is its public host contract |
| `studio/` | Studio server and dashboard (the `studio` image; a private workspace) |
| `sandboxes/` | The sandboxes service (Go, the `sandboxes` image) and the computer agent |
| `images/` | Other container images (`images/computer/`), each with a `smoke.sh` |
| `sdks/agents/`, `sdks/admin/` | `@nylorun/agents` (agents and sessions) and `@nylorun/admin` (the Management API) |
| `cli/nylorun/` | `nylorun`: local Tenants and the client of their APIs |
| `cli/create-agent/` | The starter template, its renderer, compatibility pins and smoke tests |
| `cli/legacy/` | `@nylorun/cli`: `nylorun` under another name |
| `charts/` | The Helm chart `nylorun-runtime` |
| `examples/` | The generated application shell and authored demonstrations (its own npm project and lockfile) |
| `scripts/` | Development, validation and release tooling |
| `docs/` | Public reference for operators and integrators: `self-hosting/`, `upgrading/`, `reference/` |
| `.changeset/` | Pending release notes |

## Boundaries

- `@nylorun/harness` and `@nylorun/runtime` never depend on each other; Studio depends on
  neither. Studio uses only `@nylorun/agents` and `@nylorun/admin`.
- Use the domain terms as the code does: Tenant, Agent, agent manifest, harness, Client,
  Runtime API, Management API.
- Comments explain the code. Say why a change was made in its pull request and commits. Name no
  internal plan, decision or roadmap item in code, comments, test names, messages or docs.
- A change to behaviour a page in `docs/` or a package README describes updates that page in the
  same change. User docs are at [docs.nylorun.com](https://docs.nylorun.com/llms.txt).
- A package change needs a changeset (`npm run changeset`); a change under `sandboxes/` needs a
  `@nylorun/runtime` changeset. Changelogs are generated: never hand-edit a `CHANGELOG.md` for a
  new entry.
- A Session Store migration is generated from `runtime/server/src/store/postgres/schema.ts`
  (`npm run db:generate --workspace @nylorun/runtime`). Never edit, reorder or delete a released
  migration, not even a comment: the Runtime checks each file's hash.
- A route change changes the committed OpenAPI snapshots in `runtime/server/openapi/`
  (`node scripts/build-openapi.mjs --write` in `runtime/server/`).
- Never hand-edit files owned by `examples/.scaffold-manifest.json`: change the starter or the
  recipe, then `npm run examples:sync`.
- Releases: `npm run release:prepare` on a branch, then a release PR; merging it publishes on
  npm's `beta` channel. Moving `latest` is an administrator's step: never run **Promote to
  latest** yourself.
- Don't commit secrets, `.env` files, tokens or build output.

## Commands

```bash
npm run setup     # both lockfiles and every package build
npm run check     # build and the standard checks
npm test          # package, tooling and examples tests (needs Docker)
npm run check --workspace @nylorun/runtime   # one package
cd sandboxes && go vet ./... && go test ./...
```

## Verifying your work

Run these before you report a task done, and paste their output:

| Check | Command | Healthy result |
| --- | --- | --- |
| Build and standard checks | `npm run check` | Exits 0 |
| Tests | `npm test` (needs Docker) | Every test passes; none skipped that passed before |
| One package | `npm run check --workspace <package>` | Exits 0, for each package you changed |
| Sandboxes (Go) | `cd sandboxes && go vet ./... && go test ./...` | No findings; tests pass, when you changed `sandboxes/` |
| Release notes | `npx changeset status` | A changeset for each package you changed |

If a check fails, fix the code, not the check or the test. A bug fix starts with a test that fails for
the reason you expect, committed before the fix.

## Mistakes to avoid

Corrections for mistakes agents have made in this repo more than once. Add one, with what to do
instead, when a mistake happens a second time.

- None recorded yet.
